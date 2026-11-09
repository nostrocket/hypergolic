import { Modal, type ModalProps } from 'react-native';

const supportedOrientations: ModalProps['supportedOrientations'] = ['portrait', 'portrait-upside-down', 'landscape'];

/** Keep native dialogs in the app's current system-supported orientation. */
export function ShellModal(props: ModalProps) {
  return <Modal {...props} supportedOrientations={supportedOrientations} />;
}
