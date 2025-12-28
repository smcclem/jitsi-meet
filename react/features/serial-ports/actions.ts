import { SET_SERIAL_PORT_CONNECTED } from './actionTypes';
import { SET_SERIAL_PORT_STATUS } from './actionTypes';
import type { SerialPortStatus } from './types';

/**
 * Sets whether a given serial-backed radio is connected.
 *
 * @param id - Logical radio id (e.g. 'k3Radio1').
 * @param connected - Whether it is connected.
 * @returns Redux action.
 */
export function setSerialPortConnected(id: string, connected: boolean) {
    return {
        type: SET_SERIAL_PORT_CONNECTED,
        id,
        connected
    };
}

/**
 * Sets the higher-level connection status for a given serial-backed radio.
 *
 * @param id - Logical radio id (e.g. 'k3Radio1').
 * @param status - Connection status.
 * @returns Redux action.
 */
export function setSerialPortStatus(id: string, status: SerialPortStatus) {
    return {
        type: SET_SERIAL_PORT_STATUS,
        id,
        status
    };
}
