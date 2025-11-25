// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 4000;
const clients = new Set();

function sendText(socket, str) {
    const payload = Buffer.from(str);
    const payloadLength = payload.length;
    let header;

    if (payloadLength < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = payloadLength;
    } else if (payloadLength < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payloadLength, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payloadLength), 2);
    }

    try {
        socket.write(Buffer.concat([header, payload]));
    } catch (e) {
        // ignore write errors for closed sockets
    }
}

function broadcastClientList() {
    // send array of { id, name } objects
    const clientList = Array.from(clients).map(c => ({
        id: c.id,
        name: c.username || c.id
    }));
    const message = JSON.stringify({ type: 'clientList', clients: clientList });

    for (const c of clients) {
        sendText(c, message);
    }
}

function parseFrame(buffer) {
    if (buffer.length < 2) return null;

    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) === 0x80;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;

    let payloadLen = second & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
        if (buffer.length < 4) return null;
        payloadLen = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (payloadLen === 127) {
        if (buffer.length < 10) return null;
        payloadLen = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
    }

    let maskingKey = null;
    if (masked) {
        if (buffer.length < offset + 4) return null;
        maskingKey = buffer.slice(offset, offset + 4);
        offset += 4;
    }

    if (buffer.length < offset + payloadLen) return null;

    const payload = buffer.slice(offset, offset + payloadLen);

    if (masked && maskingKey) {
        for (let i = 0; i < payloadLen; i++) {
            payload[i] ^= maskingKey[i % 4];
        }
    }

    return {
        fin,
        opcode,
        payload: payload.toString('utf8'),
        length: payloadLen,
        usedBytes: offset + payloadLen
    };
}

const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, 'public', filePath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath);
        const mime = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css'
        }[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
});

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
    }

    const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const acceptKey = crypto.createHash("sha1")
        .update(key + GUID)
        .digest("base64");

    const headers = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`
    ].join("\r\n") + "\r\n\r\n";

    socket.write(headers);

    // simple id and store
    socket.id = Math.random().toString(36).slice(2, 10);
    socket.username = null; // will be set by client
    clients.add(socket);

    // send id to the client that just connected
    setImmediate(() => {
        try {
            sendText(socket, JSON.stringify({ type: 'id', id: socket.id }));
            broadcastClientList();
        } catch (error) {
            // ignore
        }
    });

    socket.on('data', (buffer) => {
        let offset = 0;
        while (offset < buffer.length) {
            const chunk = buffer.slice(offset);
            const frame = parseFrame(chunk);
            if (!frame) break;
            offset += frame.usedBytes;

            if (frame.opcode === 0x8) { // close
                socket.end();
                clients.delete(socket);
                broadcastClientList();
                return;
            }

            if (frame.opcode === 0x1) { // text
                let data;
                try {
                    data = JSON.parse(frame.payload);
                } catch {
                    // malformed JSON
                    sendText(socket, JSON.stringify({ type: 'error', msg: 'Invalid JSON' }));
                    continue;
                }

                // handle setName
                if (data.type === 'setName') {
                    const name = String(data.name || '').trim().slice(0, 50);
                    socket.username = name || socket.id;
                    broadcastClientList();
                    continue;
                }

                // handle typing event
                if (data.type === 'typing') {
                    // forward typing indicator
                    const payload = JSON.stringify({
                        type: 'typing',
                        from: socket.id,
                        name: socket.username || socket.id,
                        to: data.to || null
                    });

                    if (data.to) {
                        // private: send only to recipient if online
                        for (const c of clients) {
                            if (c.id === data.to) {
                                sendText(c, payload);
                                break;
                            }
                        }
                    } else {
                        // broadcast to everyone except sender
                        for (const c of clients) {
                            if (c !== socket) sendText(c, payload);
                        }
                    }
                    continue;
                }

                // handle normal messages
                if (data.msg && typeof data.msg === 'string') {
                    const text = data.msg.trim();
                    if (text.length === 0) continue;
                    if (text.length > 5000) {
                        sendText(socket, JSON.stringify({ type: 'error', msg: 'Message too long (max 5000 characters)' }));
                        continue;
                    }

                    // private message
                    if (data.to) {
                        let recipientFound = false;
                        for (const c of clients) {
                            if (c.id === data.to) {
                                recipientFound = true;
                                sendText(c, JSON.stringify({
                                    type: 'message',
                                    from: socket.id,
                                    fromName: socket.username || socket.id,
                                    msg: text,
                                    isPrivate: true
                                }));
                                break;
                            }
                        }

                        // send ack back to sender
                        sendText(socket, JSON.stringify({
                            type: 'message',
                            from: socket.id,
                            fromName: socket.username || socket.id,
                            msg: text,
                            isPrivate: true,
                            isSent: true,
                            delivered: recipientFound,
                            to: data.to
                        }));
                        continue;
                    }

                    // broadcast message
                    for (const c of clients) {
                        sendText(c, JSON.stringify({
                            type: 'message',
                            from: socket.id,
                            fromName: socket.username || socket.id,
                            msg: text,
                            isPrivate: false
                        }));
                    }
                } else {
                    // unknown message type
                    sendText(socket, JSON.stringify({ type: 'error', msg: 'Unsupported message format' }));
                }
            }
        }
    });

    socket.on('close', () => {
        clients.delete(socket);
        broadcastClientList();
    });

    socket.on('error', () => {
        clients.delete(socket);
        broadcastClientList();
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
