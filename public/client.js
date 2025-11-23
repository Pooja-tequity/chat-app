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

        if (!chat || !myIdEl || !form || !msgInput) {
            return;
        }

        let myId = null;
        let availableUsers = [];

        setTimeout(() => {
            if (!myId && myIdEl) {
                myIdEl.textContent = "Connection error - Refresh page";
                myIdEl.style.color = "#ef4444";
                append("Failed to receive ID from server. Please refresh the page.", "system");
            }
        }, 3000);

        function getTimestamp() {
            const now = new Date();
            // const date = now.toLocaleDateString();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            // return `${date} - ${hours}:${minutes}`;
            return `${hours}:${minutes}`;
        }

        function append(msg, cls = "", showTimestamp = true) {
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
            
            chat.appendChild(div);
            chat.scrollTop = chat.scrollHeight;
        }

        function updateUserList(users) {
            const otherUsers = users.filter(id => id !== myId);
            availableUsers = otherUsers;
            
            if (userListEl) {
                if (otherUsers.length === 0) {
                    userListEl.innerHTML = '<option value="">No other users online</option>';
                } else {
                    userListEl.innerHTML = '<option value="">Select user to send private message (or leave empty for broadcast)</option>';
                    otherUsers.forEach(userId => {
                        const option = document.createElement("option");
                        option.value = userId;
                        option.textContent = `User: ${userId}`;
                        userListEl.appendChild(option);
                    });
                }
            }
        }

        ws.onopen = () => {
            append("Connected to server", "system");
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
                if (myIdEl) {
                    myIdEl.textContent = myId;
                }
                // append(`Your ID: ${myId}`, "system");
                return;
            }

            if (data.type === 'clientList') {
                updateUserList(data.clients);
                return;
            }

            if (data.type === 'message') {
                if (data.isPrivate) {
                    if (data.isSent) {
                        if (data.delivered === false) {
                            append(`You (to ${data.to}): ${data.msg} [User not found]`, "you");
                        } else {
                            append(`You (to ${data.to}): ${data.msg}`, "you");
                        }
                    } else {
                        append(`DM from ${data.from}: ${data.msg}`, "private");
                    }
                } else {
                    if (myId && data.from === myId) {
                        append(`You: ${data.msg}`, "you");
                    } else {
                        append(`${data.from}: ${data.msg}`, "other");
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

        ws.onclose = () => append("Disconnected from server", "system");

        ws.onerror = (error) => {
            append("Connection error occurred", "system");
        };

        form.addEventListener("submit", (e) => {
            e.preventDefault();

            const msg = msgInput.value.trim();
            const to = toInput.value.trim();

            if (!msg) return;
            if (msg.length > 1000) {
                append("Message too long (max 1000 characters)", "system");
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
