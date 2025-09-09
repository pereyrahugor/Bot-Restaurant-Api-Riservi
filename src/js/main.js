const textarea = document.getElementById('input');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const chat = document.getElementById('chat'); // style - agus

// ===== Viewport dinámico para Chrome/Firefox/iOS =====
function setAppVh() {
    const h = (window.visualViewport?.height || window.innerHeight) + 'px';
    document.documentElement.style.setProperty('--app-vh', h);
}
setAppVh();
window.addEventListener('resize', setAppVh);
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setAppVh);
}

// === Auto-grow con altura mínima y reset ===
const MIN_H = 45; // px
function autosize(el) {
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, MIN_H) + 'px';
}
autosize(textarea);
textarea.addEventListener('input', function () { autosize(this); });
// ===

// style - agus
function scrollBottom() {
    chat.scrollTop = chat.scrollHeight;
}
textarea.addEventListener('focus', scrollBottom);
textarea.addEventListener('input', scrollBottom);
// ===

async function sendMessage() {
    const msg = input.value.trim();
    if (!msg) return;
    addMessage(msg, 'user');
    input.value = '';
    textarea.style.height = MIN_H + 'px'; // reset a altura base

    try {
        const res = await fetch('/webchat-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        addMessage(data.reply, 'bot');
    } catch (err) {
        addMessage('Hubo un error procesando tu mensaje.', 'bot');
    }
}

// Enter envía / Shift+Enter = nueva línea
sendBtn.onclick = sendMessage;
input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

function addMessage(text, type) {
    const div = document.createElement('div');
    div.className = 'msg ' + type;
    div.innerText = text;
    const chat = document.getElementById('chat');
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}