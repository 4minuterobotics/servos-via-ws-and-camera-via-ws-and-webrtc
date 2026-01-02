import http from 'http';
import { WebSocketServer } from 'ws';

/**
 * Render WebSocket Relay
 * - /control  : UI <-> ESP32 servo messages (already working)
 * - /signal   : WebRTC signaling UI <-> PI (offer/answer/ice)
 *
 * Connections use query params:
 *   wss://<host>/control?role=device&id=cam1
 *   wss://<host>/control?role=ui&id=cam1
 *
 *   wss://<host>/signal?role=pi&id=cam1
 *   wss://<host>/signal?role=ui&id=cam1
 */

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
	if (req.url === '/health') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('ok\n');
		return;
	}
	res.writeHead(200, { 'content-type': 'text/plain' });
	res.end('WS relay running. Use /control and /signal\n');
});

const wss = new WebSocketServer({ noServer: true });

/** CONTROL ROOMS
 * id => { device: ws|null, uis: Set<ws> }
 */
const controlRooms = new Map();
function getControlRoom(id) {
	if (!controlRooms.has(id)) controlRooms.set(id, { device: null, uis: new Set() });
	return controlRooms.get(id);
}

/** SIGNAL ROOMS
 * id => { pi: ws|null, uis: Set<ws> }
 */
const signalRooms = new Map();
function getSignalRoom(id) {
	if (!signalRooms.has(id)) signalRooms.set(id, { pi: null, uis: new Set() });
	return signalRooms.get(id);
}

function safeJsonParse(s) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

function broadcast(set, obj) {
	const msg = JSON.stringify(obj);
	for (const ws of set) {
		if (ws.readyState === 1) ws.send(msg);
	}
}

server.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const pathname = url.pathname;

	if (pathname !== '/control' && pathname !== '/signal') {
		socket.destroy();
		return;
	}

	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit('connection', ws, req, url);
	});
});

wss.on('connection', (ws, req, url) => {
	const pathname = url.pathname;
	const role = url.searchParams.get('role') || 'ui';
	const id = url.searchParams.get('id') || 'default';

	ws._meta = { pathname, role, id };
	ws.isAlive = true;
	ws.on('pong', () => (ws.isAlive = true));

	// -----------------------
	// /control (ESP32 servos)
	// -----------------------
	if (pathname === '/control') {
		const room = getControlRoom(id);

		if (role === 'device') {
			if (room.device && room.device.readyState === 1) {
				room.device.close(1013, 'Device replaced');
			}
			room.device = ws;

			// notify UIs
			broadcast(room.uis, { type: 'device_status', online: true });
		} else {
			room.uis.add(ws);
			ws.send(JSON.stringify({ type: 'device_status', online: !!(room.device && room.device.readyState === 1) }));
		}

		ws.on('message', (buf) => {
			const msgStr = buf.toString('utf8');
			const msg = safeJsonParse(msgStr);
			if (!msg) return;

			// UI -> Device
			if (role === 'ui') {
				if (!room.device || room.device.readyState !== 1) {
					ws.send(JSON.stringify({ type: 'error', message: 'device_offline' }));
					return;
				}
				room.device.send(JSON.stringify(msg));
				return;
			}

			// Device -> UI(s)
			if (role === 'device') {
				broadcast(room.uis, msg);
			}
		});

		ws.on('close', () => {
			const room = controlRooms.get(id);
			if (!room) return;

			if (role === 'device' && room.device === ws) {
				room.device = null;
				broadcast(room.uis, { type: 'device_status', online: false });
			} else if (role === 'ui') {
				room.uis.delete(ws);
			}

			if (!room.device && room.uis.size === 0) controlRooms.delete(id);
		});

		return;
	}

	// -----------------------
	// /signal (WebRTC signaling)
	// -----------------------
	if (pathname === '/signal') {
		const room = getSignalRoom(id);

		if (role === 'pi') {
			if (room.pi && room.pi.readyState === 1) {
				room.pi.close(1013, 'Pi replaced');
			}
			room.pi = ws;

			// notify UIs that PI is online
			broadcast(room.uis, { type: 'pi_status', online: true });
		} else {
			room.uis.add(ws);
			ws.send(JSON.stringify({ type: 'pi_status', online: !!(room.pi && room.pi.readyState === 1) }));
		}

		ws.on('message', (buf) => {
			const msgStr = buf.toString('utf8');
			const msg = safeJsonParse(msgStr);
			if (!msg) return;

			// Expected signaling messages:
			// { type: "offer", sdp: "..." }
			// { type: "answer", sdp: "..." }
			// { type: "ice", candidate: {...} }
			// { type: "ready" }  (optional)
			//
			// We simply relay:
			// - UI -> PI
			// - PI -> all UIs (or you can target one UI later)

			if (role === 'ui') {
				if (!room.pi || room.pi.readyState !== 1) {
					ws.send(JSON.stringify({ type: 'error', message: 'pi_offline' }));
					return;
				}
				room.pi.send(JSON.stringify(msg));
				return;
			}

			if (role === 'pi') {
				broadcast(room.uis, msg);
				return;
			}
		});

		ws.on('close', () => {
			const room = signalRooms.get(id);
			if (!room) return;

			if (role === 'pi' && room.pi === ws) {
				room.pi = null;
				broadcast(room.uis, { type: 'pi_status', online: false });
			} else if (role === 'ui') {
				room.uis.delete(ws);
			}

			if (!room.pi && room.uis.size === 0) signalRooms.delete(id);
		});

		return;
	}
});

// Heartbeat (keeps Render/NATs happy)
setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.isAlive === false) {
			ws.terminate();
			continue;
		}
		ws.isAlive = false;
		ws.ping();
	}
}, 30000);

server.listen(PORT, () => {
	console.log(`Listening on :${PORT}`);
	console.log(`WS endpoints: /control and /signal`);
});
