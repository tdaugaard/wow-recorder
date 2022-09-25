/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * Application entrypoint point.
 */
import path from 'path';
import { app, BrowserWindow, shell, ipcMain, dialog, Tray, Menu, net } from 'electron';
import {
  resolveHtmlPath,
  loadAllVideos,
  deleteVideo,
  openSystemExplorer,
  toggleVideoProtected,
  fixPathWhenPackaged,
  getAvailableDisplays,
} from './util';
import { watchLogs, pollWowProcess, runRecordingTest, forceStopRecording } from './logutils';
const obsRecorder = require('./obsRecorder');
import { Recorder, RecorderOptionsType } from './recorder';
import { getAvailableAudioInputDevices, getAvailableAudioOutputDevices } from './obsAudioDeviceUtils';
import { AppStatus, VideoPlayerSettings } from './types';
import ConfigService from './configService';
import { getConfigValue } from 'settings/useSettings';
let recorder: Recorder;

/**
 * Setup logging. We override console log methods. All console log method will go to 
 * both the console if it exists, and a file on disk. 
 * TODO: Currently only main process logs go here. Fix so react component logs go here as well. 
 */
const log = require('electron-log');
const date = new Date().toISOString().slice(0, 10);
const logRelativePath = `logs/WarcraftRecorder-${date}.log`;
const logPath = fixPathWhenPackaged(path.join(__dirname, logRelativePath))
const logDir = path.dirname(logPath);
log.transports.file.resolvePath = () => logPath;
Object.assign(console, log.functions);
console.log("[Main] App starting: version", app.getVersion());

/**
 * Guard against any UnhandledPromiseRejectionWarnings. If OBS isn't behaving 
 * as expected then it's better to crash the app. See:
 * - https://nodejs.org/api/process.html#process_event_unhandledrejection. 
 * - https://nodejs.org/api/process.html#event-unhandledrejection
 */
 process.on('unhandledRejection', (reason: Error | any) => {
  console.error("UnhandledPromiseRejectionWarning:", reason);
  throw Error(reason);
});

/**
 * Load and return recorder options from the configuration store.
 * Does some basic sanity checking for default values.
 */
const loadRecorderOptions = (cfg: ConfigService): RecorderOptionsType => {
  const config = {
    storageDir:           cfg.get<string>('storagePath'),
    bufferStorageDir:     cfg.get<string>('bufferPath'),
    maxStorage:           cfg.get<number>('maxStorage'),
    monitorIndex:         cfg.get<number>('monitorIndex'),
    audioInputDeviceId:   cfg.get<string>('audioInputDevice'),
    audioOutputDeviceId:  cfg.get<string>('audioOutputDevice'),
    minEncounterDuration: cfg.get<number>('minEncounterDuration'),
  };

  return config;
};

/**
 * Create a settings store to handle the config.
 * This defaults to a path like: 
 *   - (prod) "C:\Users\alexa\AppData\Roaming\WarcraftRecorder\config.json"
 *   - (dev)  "C:\Users\alexa\AppData\Roaming\Electron\config.json"
 */
const cfg = new ConfigService();
let recorderOptions: RecorderOptionsType = loadRecorderOptions(cfg);
let baseLogPaths: string[] = [
  cfg.getPath('retailLogPath'),
  cfg.getPath('classicLogPath'),
];

// Default video player settings on app start
const videoPlayerSettings: VideoPlayerSettings = {
  muted: false,
  volume: 1,
};

/**
 * Define renderer windows.
 */
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray = null;

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug')();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload
    )
    .catch(console.log);
};

const RESOURCES_PATH = app.isPackaged
? path.join(process.resourcesPath, 'assets')
: path.join(__dirname, '../../assets');

const getAssetPath = (...paths: string[]): string => {
  return path.join(RESOURCES_PATH, ...paths);
};

/**
 * Setup tray icon, menu and even listeners. 
 */
const setupTray = () => {
  tray = new Tray(getAssetPath("./icon/small-icon.png"));

  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Open', click() {
        console.log("[Main] User clicked open on tray icon");
        if (mainWindow) mainWindow.show();
      }
    },
    { 
      label: 'Quit', click() { 
        console.log("[Main] User clicked close on tray icon");
        if (mainWindow) mainWindow.close();
      } 
    },
  ])

  tray.setToolTip('Warcraft Recorder')
  tray.setContextMenu(contextMenu)

  tray.on("double-click", () => {
    console.log("[Main] User double clicked tray icon");
    if (mainWindow) mainWindow.show();
  }) 
}

/**
 * Creates the main window.
 */
const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  mainWindow = new BrowserWindow({
    show: false,
    height: 1020 * 0.75,
    width: 1980 * 0.65,
    icon: getAssetPath('./icon/small-icon.png'),
    frame: false,
    title: 'Warcraft Recorder v' + app.getVersion(),
    webPreferences: {
      nodeIntegration: true,
      webSecurity: false,
      //devTools: false,
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });
  
  mainWindow.loadURL(resolveHtmlPath('mainWindow.index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) throw new Error('"mainWindow" is not defined');

    const initialStatus = checkConfig() ? AppStatus.WaitingForWoW : AppStatus.InvalidConfig;

    updateStatus(initialStatus);

    // This shows the correct version on a release build, not during development.
    mainWindow.webContents.send('updateTitleBar', 'Warcraft Recorder v' + app.getVersion());

    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }

    if (!cfg.validate()) return;

    makeRecorder(recorderOptions)
    pollWowProcess();
    watchLogs(baseLogPaths);
    checkAppUpdate();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  setupTray();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });
};

/**
 * Creates the settings window, called on clicking the settings cog.
 */
const createSettingsWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  settingsWindow = new BrowserWindow({
    show: false,
    width: 770,
    height: 500,
    resizable: (process.env.NODE_ENV === 'production') ? false : true,
    icon: getAssetPath('./icon/settings-icon.svg'),
    frame: false,
    webPreferences: {
      webSecurity: false,
      //devTools: false,
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  settingsWindow.loadURL(resolveHtmlPath("settings.index.html"));

  settingsWindow.on('ready-to-show', () => {
    if (!settingsWindow) {
      throw new Error('"settingsWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      settingsWindow.minimize();
    } else {
      settingsWindow.show();
    }
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  // Open urls in the user's browser
  settingsWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });
};

const openPathDialog = (event: any, args: any) => {
  if (!settingsWindow) return;
  const setting = args[1];
  
  dialog.showOpenDialog(settingsWindow, { properties: ['openDirectory'] }).then(result => {
    if (!result.canceled) {
      event.reply('settingsWindow', ['pathSelected', setting, result.filePaths[0]]);
    }
  })
  .catch(err => {
    console.log(err);
  })
} 
/**
 * Checks the app config.
 * @returns true if config is setup, false otherwise. 
 */
const checkConfig = () : boolean => {
  if (mainWindow === null) {
    return false;
  }
  
  return cfg.validate();
}

/**
 * Updates the status icon for the application.
 * @param status the status number
 */
const updateStatus = (status: AppStatus) => {
  if (mainWindow !== null) mainWindow.webContents.send('updateStatus', status);
}

/**
 * mainWindow event listeners.
 */
ipcMain.on('mainWindow', (_event, args) => {
  if (mainWindow === null) return; 

  if (args[0] === "minimize") {
    console.log("[Main] User clicked minimize");
    //mainWindow.minimize();
    mainWindow.hide();
  }

  if (args[0] === "resize") {
    console.log("[Main] User clicked resize");
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }

  if (args[0] === "quit"){
    console.log("[Main] User clicked quit");
    mainWindow.close();
  }
})

/**
 * Create or reconfigure the recorder instance
 */
const makeRecorder = (recorderOptions: RecorderOptionsType): void => {
  if (recorder) {
    recorder.reconfigure(recorderOptions);
  } else {
    recorder = new Recorder(recorderOptions);
  }
}

/**
 * settingsWindow event listeners.
 */
ipcMain.on('settingsWindow', (event, args) => {

  if (args[0] === "create") {
    console.log("[Main] User clicked open settings");
    if (!settingsWindow) createSettingsWindow();
  }

  if (args[0] === "startup") {
    const isStartUp = (args[1] === "true");
    console.log("[Main] OS level set start-up behaviour: ", isStartUp);

    app.setLoginItemSettings({
      openAtLogin: isStartUp    
    })
  }
    
  if (settingsWindow === null) return; 
  
  if (args[0] === "quit") {
    console.log("[Main] User closed settings");
    settingsWindow.close();
  }

  if (args[0] === "update") {
    console.log("[Main] User updated settings");
    
    settingsWindow.once('closed', () => {
      if (!checkConfig()) {
        updateStatus(AppStatus.InvalidConfig);
        return;
      }

      updateStatus(AppStatus.WaitingForWoW);

      // If this is the first time config has been valid we
      // need to create a recorder. If the config was previously
      // valid but has since changed, just do a reconfigure.

      recorderOptions = loadRecorderOptions(cfg);
      makeRecorder(recorderOptions);

      baseLogPaths = [
        cfg.getPath('log-path'),
        cfg.getPath('log-path-classic'),
      ];
      watchLogs(baseLogPaths);

      pollWowProcess();
    })

    settingsWindow.close();
  }

  if (args[0] === "openPathDialog") {
      openPathDialog(event, args);
      return;
  }

  if (args[0] === 'getAllDisplays') {
    event.returnValue = getAvailableDisplays();
    return;
  }
})

/**
 * contextMenu event listeners.
 */
ipcMain.on('contextMenu', (event, args) => {
  if (args[0] === "delete") {
    const videoForDeletion = args[1];
    deleteVideo(videoForDeletion);
    if (mainWindow) mainWindow.webContents.send('refreshState');
  }

  if (args[0] === "open") {
    const fileToOpen = args[1];
    openSystemExplorer(fileToOpen);
  }

  if (args[0] === "save") {
    const videoToToggle = args[1];
    toggleVideoProtected(videoToToggle);
    if (mainWindow) mainWindow.webContents.send('refreshState');
  }

  if (args[0] === "seekVideo") {
    const videoIndex = parseInt(args[1], 10);
    const seekTime = parseInt(args[2], 10);
    if (mainWindow) mainWindow.webContents.send('seekVideo', videoIndex, seekTime);
  }
})

/**
 * logPath event listener.
 */
 ipcMain.on('logPath', (event, args) => {
  if (args[0] === "open") {
    openSystemExplorer(logDir);
  }
})

/**
 * openURL event listener.
 */
 ipcMain.on('openURL', (event, args) => {
  event.preventDefault();
  require('electron').shell.openExternal(args[0]);
})

/**
 * Get the list of video files and their state.
 */
ipcMain.handle('getVideoState', async () => loadAllVideos(recorderOptions.storageDir));

ipcMain.on('getAudioDevices', (event) => {
  // We can only get this information if the recorder (OBS) has been
  // initialized and that only happens when the storage directory has
  // been configured.
  if (!recorder) {
    event.returnValue = { input: [], output: [] };
    return;
  }

  event.returnValue = {
    input: getAvailableAudioInputDevices(),
    output: getAvailableAudioOutputDevices(),
  };
});

/**
 * Set/Get global video player settings
 */
ipcMain.on('videoPlayerSettings', (event, args) => {
  switch (args[0]) {
    case 'get':
      event.returnValue = videoPlayerSettings;
      break;

    case 'set':
      const settings = (args[1] as VideoPlayerSettings);

      videoPlayerSettings.muted = settings.muted;
      videoPlayerSettings.volume = settings.volume;
      break;
  }
});

/**
 * Test button listener. 
 */
ipcMain.on('test', (_event, args) => {
  if (cfg.validate()) { 
    console.info("[Main] Config is good, running test!");
    runRecordingTest(Boolean(args[0]));
  } else {
    console.info("[Main] Config is bad, don't run test");
  }
});

/**
 * Recorder IPC functions
 */
ipcMain.on('recorder', (_event, args) => {
  if (args[0] == 'stop') {
    console.log('[Main] Force stopping recording due to user request.')
    forceStopRecording();
  }
});

/**
 * Shutdown the app if all windows closed. 
 */
app.on('window-all-closed', () => {
  console.log("[Main] User closed app");
  if (recorder) recorder.cleanupBuffer(0);
  obsRecorder.shutdown();
  app.quit();
});

/**
 * Checks for updates from the releases page on github, and, if there is a new version, sends a message to the main window to display a notification
 */
const checkAppUpdate = () => {
  const options = {
    hostname: 'api.github.com',
    protocol: 'https:',
    path: '/repos/aza547/wow-recorder/releases/latest',
    method: 'GET',
    headers: {
      'User-Agent': 'wow-recorder',
    }
  }

  const request = net.request(options);
  
  request.on('response', (response) => {
    let data = '';

    response.on('data', (chunk) => {
      data += chunk;
    });

    response.on('end', () => {
      if (response.statusCode !== 200) {
        console.error(`[Main] ERROR, Failed to check for updates, status code: ${response.statusCode}`);
        return;
      }

      const release = JSON.parse(data);
      const latestVersion = release.tag_name;
      const downloadUrl = release.assets[0].browser_download_url;

      if (latestVersion !== app.getVersion() && latestVersion && downloadUrl) {
        console.log("[Main] New version available:", latestVersion);
        if (mainWindow) mainWindow.webContents.send('updateAvailable', downloadUrl);
      }
    });
  });

  request.on('error', (error) => {
    console.error(`[Main] ERROR, Failed to check for updates: ${error}`);
  });

  request.end();
}

/**
 * App start-up.
 */
app
  .whenReady()
  .then(() => {
    console.log("[Main] App ready");
    createWindow();
  })
  .catch(console.log);

export {
  mainWindow,
  recorder
};
