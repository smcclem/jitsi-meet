import React from 'react';
import { makeStyles } from 'tss-react/mui';

interface IProps {
    status?: 'connected' | 'warning';
}

const useStyles = makeStyles()(theme => {
    return {
        ledBase: {
            width: 8,
            height: 8,
            borderRadius: '50%',
            marginLeft: 'auto',
            flex: '0 0 auto'
        },
        ledConnected: {
            backgroundColor: theme.palette.success01
        },
        ledWarning: {
            backgroundColor: theme.palette.warning02
        }
    };
});

export default function SerialConnectionLed({ status }: IProps) {
    const { classes } = useStyles();

    if (!status) {
        return null;
    }

    const className = status === 'warning'
        ? `${classes.ledBase} ${classes.ledWarning}`
        : `${classes.ledBase} ${classes.ledConnected}`;

    return <span className = { className } />;
}
