import PropTypes from 'prop-types';

export enum showDialogOption {
  NeverShowDialog = 'never',
  AlwaysShowDialog = 'always',
  ShowOnceAndConfigure = 'configure',
}

// The "investigational use only" dialog is disabled in all modes (including dev),
// regardless of the `investigationalUseDialog` config. This component is a no-op
// so that no config can re-enable the popup.
const InvestigationalUseDialog = (_props) => {
  return null;
};

InvestigationalUseDialog.propTypes = {
  dialogConfiguration: PropTypes.shape({
    option: PropTypes.oneOf(Object.values(showDialogOption)).isRequired,
    days: PropTypes.number,
  }),
};

export default InvestigationalUseDialog;
