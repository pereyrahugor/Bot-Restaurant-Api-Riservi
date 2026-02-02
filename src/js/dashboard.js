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
            if (data.groups.active) {
                groupsStatusEl.textContent = `✅ Conectado (${data.groups.phoneNumber || 'Motor de Grupos'})`;
                groupsStatusEl.style.color = '#28a745';
                if (qrSection) qrSection.style.display = 'none';
            } else if (data.groups.qr) {
                groupsStatusEl.textContent = '⚠️ Esperando vinculación (Escanea el QR abajo)';
                groupsStatusEl.style.color = '#ffc107';
                if (qrSection) {
                    qrSection.style.display = 'block';
                    const qrImg = qrSection.querySelector('.qr');
                    if (qrImg) qrImg.src = '/groups-qr.png?t=' + Date.now();
                }
            } else if (data.groups.source === 'local') {
                groupsStatusEl.textContent = '🔄 Restaurando sesión local...';
                groupsStatusEl.style.color = '#17a2b8';
            } else if (data.groups.hasRemote) {
                groupsStatusEl.textContent = '📥 Descargando sesión desde Supabase...';
                groupsStatusEl.style.color = '#17a2b8';
            } else {
                groupsStatusEl.textContent = '❌ Desconectado (No hay sesión)';
                groupsStatusEl.style.color = '#dc3545';
                if (qrSection) qrSection.style.display = 'block';
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
