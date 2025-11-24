const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT =4000
const clients = new Set();

function sendText(socket, str) {
    const payload = Buffer.from(str);
    const payloadLength = payload.length;
    let header;

    if (payloadLength < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = payloadLength;
    }
    else if (payloadLength < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payloadLength, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payloadLength), 2);
    }

    socket.write(Buffer.concat([header, payload]));
}

function broadcastClientList() {
    const clientList = Array.from(clients).map(c => c.id);
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

    socket.id = Math.random().toString(36).slice(2, 10);
    clients.add(socket);

    setImmediate(() => {
        try {
            const idMessage = JSON.stringify({ type: 'id', id: socket.id });
            sendText(socket, idMessage);
            broadcastClientList();
        } catch (error) {
        }
    });
    socket.on('data', (buffer) => {
        let offset = 0;
        while (offset < buffer.length) {
            const chunk = buffer.slice(offset);
            const frame = parseFrame(chunk);
            if (!frame) break;
            offset += frame.usedBytes;

            if (frame.opcode === 0x8) {
                socket.end();
                clients.delete(socket);
                return;
            }

            if (frame.opcode === 0x1) {
                let data;
                try {
                    data = JSON.parse(frame.payload);
                } catch {
                    return;
                }

                if (data.to) {
                    if (!data.msg || typeof data.msg !== 'string' || data.msg.trim().length === 0) {
                        return;
                    }
                    if (data.msg.length > 1000) {
                        sendText(socket, JSON.stringify({ 
                            type: 'error', 
                            msg: 'Message too long (max 1000 characters)' 
                        }));
                        return;
                    }

                    let recipientFound = false;
                    for (const c of clients) {
                        if (c.id === data.to) {
                            recipientFound = true;
                            sendText(c, JSON.stringify({ 
                                type: 'message', 
                                from: socket.id, 
                                msg: data.msg, 
                                isPrivate: true 
                            }));
                            break;
                        }
                    }
                    
                    sendText(socket, JSON.stringify({ 
                        type: 'message', 
                        from: socket.id, 
                        to: data.to,
                        msg: data.msg, 
                        isPrivate: true,
                        isSent: true,
                        delivered: recipientFound
                    }));
                    return;
                }

                if (!data.msg || typeof data.msg !== 'string' || data.msg.trim().length === 0) {
                    return;
                }
                if (data.msg.length > 1000) {
                    sendText(socket, JSON.stringify({ 
                        type: 'error', 
                        msg: 'Message too long (max 1000 characters)' 
                    }));
                    return;
                }

                for (const c of clients) {
                    sendText(c, JSON.stringify({ 
                        type: 'message', 
                        from: socket.id, 
                        msg: data.msg, 
                        isPrivate: false 
                    }));
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