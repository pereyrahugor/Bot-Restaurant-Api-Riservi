async function fetchStatus() {
    try {
        const res = await fetch('/api/dashboard-status');
        const data = await res.json();

        const statusEl = document.getElementById('session-status');
        const qrSection = document.getElementById('qr-section');
        const sessionInfo = document.getElementById('session-info');
        const sessionError = document.getElementById('session-error');

        if (data.active) {
            qrSection.style.display = 'none';
            sessionInfo.style.display = '';

            const groupsStatusEl = document.getElementById('groups-status');
            if (data.source === 'ycloud-api') {
                statusEl.textContent = '✅ Conectado vía YCloud';
                sessionInfo.textContent = 'El bot está operando por API (YCloud).';
                sessionInfo.style.color = '#28a745';

                if (groupsStatusEl) {
                    groupsStatusEl.textContent = data.groupsConnected ?
                        '✅ El bot está operando por API y los grupos están CONECTADOS.' :
                        '❌ El bot está operando por API, pero los grupos están DESCONECTADOS (Escanea el QR).';
                    groupsStatusEl.style.color = data.groupsConnected ? '#28a745' : '#ffc107';
                }
            } else if (data.source === 'connected') {
                statusEl.textContent = '✅ Conectado y Operativo';
                sessionInfo.textContent = 'El bot está vinculado a WhatsApp y funcionando correctamente.';
                sessionInfo.style.color = '#28a745';
            } else {
                statusEl.textContent = '✅ Sesión Local Detectada';
                sessionInfo.textContent = 'El bot tiene archivos de sesión. Si no responde en WhatsApp, intenta reiniciar.';
                sessionInfo.style.color = '';
            }
        } else {
            qrSection.style.display = '';
            // ... resto igual ...

            if (data.hasRemote) {
                statusEl.textContent = '⏳ Restaurando...';
                sessionInfo.style.display = '';
                sessionInfo.textContent = data.message || 'Intentando recuperar sesión de la nube...';
                sessionInfo.style.color = '#ffc107';
            } else {
                statusEl.textContent = '⏳ Esperando Escaneo';
                sessionInfo.style.display = 'none';
            }

            // Intentar recargar el QR
            const qrImg = document.querySelector('.qr');
            qrImg.src = '/qr.png?t=' + Date.now();
            qrImg.style.display = 'inline-block';
            qrImg.nextElementSibling.style.display = 'none';
        }

        if (data.error) {
            sessionError.innerHTML = `<div class='error-box'>⚠️ Error al verificar sesión: ${data.error}</div>`;
        } else {
            sessionError.innerHTML = '';
        }
    } catch (e) {
        document.getElementById('session-status').textContent = 'Error';
        document.getElementById('session-error').innerHTML = `<div class='error-box'>No se pudo obtener el estado del bot.</div>`;
    }
}
fetchStatus();
setInterval(fetchStatus, 10000);

// Redirigir a /webreset al hacer click en el botón de reinicio
document.getElementById('go-reset').addEventListener('click', function () {
    window.location.href = '/webreset';
});
