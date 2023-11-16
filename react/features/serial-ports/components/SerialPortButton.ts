import { connect } from 'react-redux';

import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { openDialog } from '../../base/dialog/actions';
import { isMobileBrowser } from '../../base/environment/utils';
import { translate } from '../../base/i18n/functions';
import { IconSerialPort } from '../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../base/toolbox/components/AbstractButton';
import { isVpaasMeeting } from '../../jaas/functions';


/**
 * Implementation of a button for using Web Serial API.
 */
class SerialPortButton extends AbstractButton<AbstractButtonProps> {
    accessibilityLabel = 'toolbar.accessibilityLabel.serialPort';
    icon = IconSerialPort;
    label = 'toolbar.serialPort';
    tooltip = 'toolbar.serialPort';

    /**
     * Handles clicking / pressing the button, and opens the appropriate dialog.
     *
     * @protected
     * @returns {void}
     */
    _handleClick() {
        const { dispatch } = this.props;

        // sendAnalytics(createToolbarEvent('embed.meeting'));
        // TODO: New function here
    }
}

/**
 * Function that maps parts of Redux state tree into component props.
 *
 * @param {Object} state - Redux state.
 * @returns {Object}
 */
const mapStateToProps = (state: IReduxState) => {
    return {
        visible: !isVpaasMeeting(state) && !isMobileBrowser()
    };
};

export default translate(connect(mapStateToProps)(SerialPortButton));
