"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EIP_PORT = void 0;
exports.connectOnPort = connectOnPort;
exports.connectedPort = connectedPort;
/**
 * Connect st-ethernet-ip on a port other than 44818 (#18).
 *
 * The library takes no port (SerafinTech/ST-node-ethernet-ip#85): ENIP.connect() builds its
 * socket options from the EIP_PORT constant in its dist/config.js, after an await. That
 * constant is replaced here by a getter returning the port of the connect call it is read
 * in, tracked with AsyncLocalStorage. Nothing global changes while a connect is in flight,
 * so endpoints on different ports, and a reconnect running while another endpoint connects,
 * cannot pick up each other's port.
 *
 * If the library ever stops reading the port this way, the endpoint notices: it checks the
 * port the socket actually connected to (see connectedPort).
 * @module eip-port
 */
const async_hooks_1 = require("async_hooks");
exports.DEFAULT_EIP_PORT = 44818;
const portOfCall = new async_hooks_1.AsyncLocalStorage();
let installed = null;
/** Swap the library's EIP_PORT constant for the getter. Returns false if that is not possible. */
function install() {
    if (installed !== null)
        return installed;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const config = require("st-ethernet-ip/dist/config");
        const desc = Object.getOwnPropertyDescriptor(config, "EIP_PORT");
        if (!desc || !desc.configurable) {
            installed = false;
        }
        else {
            Object.defineProperty(config, "EIP_PORT", {
                configurable: true,
                enumerable: true,
                get: () => portOfCall.getStore() ?? exports.DEFAULT_EIP_PORT,
            });
            installed = true;
        }
    }
    catch {
        installed = false;
    }
    return installed;
}
/**
 * Run `connect` so that st-ethernet-ip dials `port`. Always sets the port, also for 44818:
 * a reconnect can start from a callback of another endpoint's socket and would otherwise
 * inherit that endpoint's port.
 */
function connectOnPort(port, connect) {
    if (!install()) {
        if (port === exports.DEFAULT_EIP_PORT)
            return connect();
        return Promise.reject(new Error(`Port ${port} cannot be used: this version of st-ethernet-ip only connects on ${exports.DEFAULT_EIP_PORT}`));
    }
    return portOfCall.run(port, connect);
}
/** The remote port a connected Controller's socket is on, or null if it is not known. */
function connectedPort(plc) {
    const port = plc && plc.remotePort;
    return typeof port === "number" ? port : null;
}
//# sourceMappingURL=eip-port.js.map