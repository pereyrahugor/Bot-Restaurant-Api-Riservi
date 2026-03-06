async function fetchStatus() {
    try {
        const res = await fetch('/api/dashboard-status');
        const data = await res.json();

        if (data.error) {
            document.getElementById('session-error').innerHTML = `<div class='error-box'>⚠️ Error: ${data.error}</div>`;
            return;
        }

        const statusEl = document.getElementById('session-status');
        const groupsStatusEl = document.getElementById('groups-status');
        const groupsStatusDetailEl = document.getElementById('groups-status-detail');
        const qrSection = document.getElementById('qr-section');
        const sessionInfo = document.getElementById('session-info');

        // 1. Estado YCloud (Principal)
        if (data.ycloud && data.ycloud.active) {
            statusEl.textContent = '✅ Operativo (Meta API)';
            statusEl.className = 'status status-online';
            if (sessionInfo) {
                sessionInfo.style.display = 'block';
                sessionInfo.textContent = `Número WABA: ${data.ycloud.phoneNumber || 'Configurado'}`;
            }
        } else {
            statusEl.textContent = '❌ Error de Configuración';
            statusEl.className = 'status status-offline';
        }

        // 2. Estado de Grupos (Baileys)
        if (data.groups) {
            let statusText = '';
            let statusColor = '';
            let showQr = false;

            if (data.groups.active) {
                statusText = `✅ Conectado (${data.groups.phoneNumber || 'Motor de Grupos'})`;
                statusColor = '#28a745';
                showQr = false;
            } else if (data.groups.qr) {
                statusText = '⚠️ Esperando vinculación';
                statusColor = '#ffc107';
                showQr = true;
            } else if (data.groups.source === 'local') {
                statusText = '🔄 Restaurando sesión local...';
                statusColor = '#17a2b8';
                showQr = false;
            } else if (data.groups.hasRemote) {
                statusText = '📥 Descargando sesión...';
                statusColor = '#17a2b8';
                showQr = false;
            } else {
                statusText = '❌ Desconectado';
                statusColor = '#dc3545';
                showQr = true;
            }

            if (groupsStatusEl) {
                groupsStatusEl.textContent = statusText;
                groupsStatusEl.style.color = statusColor;
            }
            if (groupsStatusDetailEl) {
                groupsStatusDetailEl.textContent = statusText;
                groupsStatusDetailEl.style.color = statusColor;
            }

            if (qrSection) {
                qrSection.style.display = showQr ? 'block' : 'none';
                if (showQr) {
                    const qrImg = qrSection.querySelector('.qr');
                    if (qrImg) qrImg.src = '/groups-qr.png?t=' + Date.now();
                }
            }
        }

    } catch (e) {
        console.error('Error fetchStatus:', e);
    }
}

fetchStatus();
setInterval(fetchStatus, 10000);

document.getElementById('go-reset')?.addEventListener('click', function () {
    if (confirm('¿Estás seguro de que deseas eliminar la sesión de grupos? Esto forzará un nuevo escaneo QR.')) {
        window.location.href = '/webreset';
    }
});

document.getElementById('show-qr-btn')?.addEventListener('click', function () {
    const qrSec = document.getElementById('qr-section');
    if (qrSec) {
        qrSec.scrollIntoView({ behavior: 'smooth' });
        qrSec.style.display = 'block'; // Asegurar que sea visible si el bot cree que no es necesario pero el usuario quiere verlo
    }
});
