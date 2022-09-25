import * as React from 'react';

export function getConfigValue<T>(configKey: string): T {
  return (window.electron.ipcRenderer.sendSync('config', ['get', configKey]) as T);
};

export const setConfigValue = (configKey: string, value: any): void => {
  window.electron.ipcRenderer.sendMessage('config', ['set', configKey, value]);
};

export const configSettings = [
  'storagePath',
  'retailLogPath',
  'classicLogPath',
  'maxStorage',
  'minEncounterDuration',
  'monitorIndex',
  'audioInputDevice',
  'audioOutputDevice',
  'bufferPath',
  'startUp',
];

export default function useSettings() {
  const [config, setConfig] = React.useState({
    storagePath:          getConfigValue<string>('storagePath'),
    retailLogPath:        getConfigValue<string>('retailLogPath'),
    classicLogPath:       getConfigValue<string>('classicLogPath'),
    maxStorage:           getConfigValue<number>('maxStorage'),
    minEncounterDuration: getConfigValue<number>('minEncounterDuration'),
    monitorIndex:         getConfigValue<number>('monitorIndex'),
    audioInputDevice:     getConfigValue<string>('audioInputDevice'),
    audioOutputDevice:    getConfigValue<string>('audioOutputDevice'),
    bufferPath:           getConfigValue<string>('bufferPath'),
    startUp:              getConfigValue<boolean>('startUp'),
    tabIndex: 0,
    retail: true,
    classic: false,
    raids: true,
    dungeons: true,
    twoVTwo: true,
    threeVThree: true,
    skirmish: true,
    soloShuffle: true,
    battlegrounds: true,
  });

  return [config, setConfig];
};
