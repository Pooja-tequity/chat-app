(function () {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    function init() {
        const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(wsProto + "//" + location.host);

        const chat = document.getElementById("chat");
        const myIdEl = document.getElementById("myId");
        const userListEl = document.getElementById("userList");

        const form = document.getElementById("form");
        const msgInput = document.getElementById("msg");
        const toInput = document.getElementById("to");
        const usernameForm = document.getElementById("usernameForm");
        const usernameInput = document.getElementById("username");
        const setNameBtn = document.getElementById("setNameBtn");

        if (!chat || !myIdEl || !form || !msgInput) {
            return;
        }

        let myId = null;
        let myName = null;
        let availableUsers = [];
        let typingTimers = {}; // { userId: timeoutId }

        function getTimestamp() {
            const now = new Date();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            return `${hours}:${minutes}`;
        }

        function append(msg, cls = "", showTimestamp = true, meta = {}) {
            const div = document.createElement("div");
            div.className = "msg " + cls;

            if (showTimestamp && cls !== "system") {
                const timestamp = getTimestamp();
                const msgText = document.createTextNode(msg);
                const timeSpan = document.createElement("span");
                timeSpan.className = "timestamp";
                timeSpan.textContent = ` [${timestamp}]`;
                timeSpan.style.opacity = "0.6";
                timeSpan.style.fontSize = "0.85em";

                div.appendChild(msgText);
                div.appendChild(timeSpan);
            } else {
                div.textContent = msg;
            }

            if (meta && meta.small) {
                div.style.fontSize = "0.95em";
                div.style.opacity = "0.9";
            }

            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
        }

        function updateUserList(users) {
            // users: array of { id, name }
            const otherUsers = users.filter(u => u.id !== myId);
            availableUsers = otherUsers;

            if (userListEl) {
                if (otherUsers.length === 0) {
                    userListEl.innerHTML = '<option value="">No other users online</option>';
                } else {
                    userListEl.innerHTML = '<option value="">Select user to send private message (or leave empty for broadcast)</option>';
                    otherUsers.forEach(user => {
                        const option = document.createElement("option");
                        option.value = user.id;
                        option.textContent = `${user.name} (${user.id})`;
                        userListEl.appendChild(option);
                    });
                }
            }
        }

        ws.onopen = () => {
            append("Connected to server", "system");
            // disable message composer until username set
            msgInput.disabled = true;
            setNameBtn.disabled = false;
        };

        ws.onmessage = (ev) => {
            let data;
            try {
                data = JSON.parse(ev.data);
            } catch (e) {
                append(ev.data);
                return;
            }

            if (data.type === 'id') {
                myId = data.id;
                if (myIdEl) myIdEl.textContent = myId;
                return;
            }

            if (data.type === 'clientList') {
                updateUserList(data.clients || []);
                return;
            }

            if (data.type === 'typing') {
                // show typing indicator (small system message)
                const fromName = data.name || data.from;
                const fromId = data.from;
                // If private & not recipient, ignore
                if (data.to && data.to !== myId) return;

                // remove previous timer and message
                if (typingTimers[fromId]) {
                    clearTimeout(typingTimers[fromId]);
                } else {
                    append(`${fromName} is typing...`, "system", false, { small: true });
                }

                // clear the typing message after 1.8s
                typingTimers[fromId] = setTimeout(() => {
                    // Remove the last "system small" message matching this user
                    const systemMsgs = Array.from(document.querySelectorAll('.msg.system'));
                    for (let i = systemMsgs.length - 1; i >= 0; i--) {
                        const el = systemMsgs[i];
                        if (el.textContent && el.textContent.includes(`${fromName} is typing`)) {
                            el.remove();
                            break;
                        }
                    }
                    delete typingTimers[fromId];
                }, 1800);

                return;
            }

            if (data.type === 'message') {
                // Private message
                if (data.isPrivate) {
                    let user = availableUsers.find(u => u.id === data.to);
                    let name = user ? user.name : data.to;
                    // If it's an ack to sender (isSent)
                    if (data.isSent) {
                        if (data.delivered === false) {
                            append(`to ${name}: ${data.msg} [User not found]`, "you");
                        } else {
                            append(`to ${name}: ${data.msg}`, "you");
                        }
                    } else {
                        // incoming private
                        append(`${data.fromName || data.from}: ${data.msg}`, "private");
                    }
                } else {
                    // broadcast message
                    if (myId && data.from === myId) {
                        append(`You: ${data.msg}`, "you");
                    } else {
                        append(`${data.fromName || data.from}: ${data.msg}`, "other");
                    }
                }
                return;
            }

            if (data.type === 'error') {
                append(`Error: ${data.msg}`, "system");
                return;
            }

            append(ev.data);
        };

        ws.onclose = () => {
            append("Disconnected from server", "system");
            msgInput.disabled = true;
            setNameBtn.disabled = true;
        };

        ws.onerror = (error) => {
            append("Connection error occurred", "system");
        };

        // typing -> send typing events when user types
        msgInput.addEventListener("input", () => {
            if (ws.readyState !== WebSocket.OPEN) return;
            // short-circuit: if username not set, don't send typing
            if (!myName) return;

            const to = toInput.value.trim() || null;
            ws.send(JSON.stringify({ type: 'typing', to }));
        });

        // username setup
        usernameForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const name = String(usernameInput.value || "").trim();
            if (!name) {
                alert("Please enter a username");
                return;
            }
            if (ws.readyState !== WebSocket.OPEN) {
                alert("Connection not ready");
                return;
            }
            myName = name.slice(0, 50);
            ws.send(JSON.stringify({ type: "setName", name: myName }));
            // append(`You set username: ${myName}`, "system");
            myIdEl.innerHTML = `${myName} <span style="opacity:0.7;">(ID: ${myId})</span>`;
            // enable composer
            msgInput.disabled = false;
            usernameInput.disabled = true;
            setNameBtn.disabled = true;
        });

        form.addEventListener("submit", (e) => {
            e.preventDefault();

            const msg = msgInput.value.trim();
            const to = toInput.value.trim();

            if (!msg) return;
            if (msg.length > 5000) {
                append("Message too long (max 5000 characters)", "system");
                return;
            }

            const packet = {
                msg,
                to: to || null
            };

            ws.send(JSON.stringify(packet));

            msgInput.value = "";
            toInput.value = "";
            if (userListEl) userListEl.value = "";
        });

        if (userListEl) {
            userListEl.addEventListener("change", (e) => {
                toInput.value = e.target.value;
            });
        }
    }
})();
