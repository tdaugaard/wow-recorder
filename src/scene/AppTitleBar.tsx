import icon from '../../assets/icon/small-icon.png';

const ipc = window.electron.ipcRenderer;

const clickedQuit = () => {
  ipc.sendMessage('sceneWindow', ['quit']);
};

export default function AppTitleBar() {
  return (
    <div id="title-bar">
      <div id="logo">
        <img alt="icon" src={icon} height="25px" width="25px" />
      </div>
      <div id="title">Edit Scene &ndash; Warcraft Recorder</div>
      <div id="title-bar-btns">
        <button id="close-btn" onClick={clickedQuit}>✖</button>
      </div>
    </div>
  );
}
