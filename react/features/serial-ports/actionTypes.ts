/**
 * The type of (redux) action to set the connection state of a serial-backed radio.
 *
 * {
 *     type: SET_SERIAL_PORT_CONNECTED,
 *     id: string,
 *     connected: boolean
 * }
 */
export const SET_SERIAL_PORT_CONNECTED = 'SET_SERIAL_PORT_CONNECTED';

/**
 * The type of (redux) action to set the connection status of a serial-backed radio.
 *
 * {
 *     type: SET_SERIAL_PORT_STATUS,
 *     id: string,
 *     status: 'disconnected' | 'connecting' | 'reconnecting' | 'connected'
 * }
 */
export const SET_SERIAL_PORT_STATUS = 'SET_SERIAL_PORT_STATUS';
