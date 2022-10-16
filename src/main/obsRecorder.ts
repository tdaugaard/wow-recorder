import { fixPathWhenPackaged, getAvailableDisplays } from "./util";
import WaitQueue from 'wait-queue';
import { getAvailableAudioInputDevices, getAvailableAudioOutputDevices } from "./obsAudioDeviceUtils";
import { RecorderOptionsType } from "./recorder";
import { OurDisplayType } from "./types";
import { BrowserWindow, Rectangle, Size } from "electron";
import { ISceneItem, IScene, IInput, ISource } from "obs-studio-node";
import path from 'path';
import { inspectObject } from "./helpers";
const waitQueue = new WaitQueue<any>();
const osn = require("obs-studio-node");
const { v4: uuid } = require('uuid');

let obsInitialized = false;
// Timer for periodically checking the size of the video source
let timerVideoSourceSize: any;
// Previous size of the video source as checked by checkVideoSourceSize()
let lastVideoSourceSize: Size;
let scene: IScene;

/*
* Reconfigure the recorder without destroying it.
*/
const reconfigure = (options: RecorderOptionsType) => {
  configureOBS(options);
  setupScene(options);
  setupSources(scene, options.audioInputDeviceId, options.audioOutputDeviceId);
}

/**
 * Parse a resolution string like '1920x1080' into a `Size` compatible
 * format.
 */
const parseResolutionsString = (value: string): Size => {
  const [width, height] = value.split('x').map(v => parseInt(v, 10));

  return { width, height };
};

/*
* Init the library, launch OBS Studio instance, configure it, set up sources and scene
*/
const initialize = (options: RecorderOptionsType) => {
  if (obsInitialized) {
    console.warn("[OBS] OBS is already initialized");
    return;
  }

  initOBS();
  reconfigure(options);
  obsInitialized = true;
}

/*
* initOBS
*/
const initOBS = () => {
  console.debug('[OBS] Initializing OBS...');
  osn.NodeObs.IPC.host(`warcraft-recorder-${uuid()}`);
  osn.NodeObs.SetWorkingDirectory(fixPathWhenPackaged(path.join(__dirname,'../../', 'node_modules', 'obs-studio-node')));

  const obsDataPath = fixPathWhenPackaged(path.join(__dirname, 'osn-data')); // OBS Studio configs and logs
  // Arguments: locale, path to directory where configuration and logs will be stored, your application version
  const initResult = osn.NodeObs.OBS_API_initAPI('en-US', obsDataPath, '1.0.0');

  if (initResult !== 0) {
    const errorReasons = {
      '-2': 'DirectX could not be found on your system. Please install the latest version of DirectX for your machine here <https://www.microsoft.com/en-us/download/details.aspx?id=35?> and try again.',
      '-5': 'Failed to initialize OBS. Your video drivers may be out of date, or Streamlabs OBS may not be supported on your system.',
    }

    // @ts-ignore
    const errorMessage = errorReasons[initResult.toString()] || `An unknown error #${initResult} was encountered while initializing OBS.`;

    console.error('[OBS] OBS init failure', errorMessage);

    shutdown();

    throw Error(errorMessage);
  }

  osn.NodeObs.OBS_service_connectOutputSignals((signalInfo: any) => {
    waitQueue.push(signalInfo);
  });

  console.debug('[OBS] OBS initialized');
}

/*
* configureOBS
*/
const configureOBS = (options: RecorderOptionsType) => {
  console.debug('[OBS] Configuring OBS');
  setSetting('Output', 'Mode', 'Advanced');

  setObsRecEncoder(options);

  // Set output path and video format.
  setSetting('Output', 'RecFilePath', options.bufferStorageDir);
  setSetting('Output', 'RecFormat', 'mp4');

  // VBR is "Variable Bit Rate", read about it here:
  // https://blog.mobcrush.com/using-the-right-rate-control-in-obs-for-streaming-or-recording-4737e22895ed
  setSetting('Output', 'Recrate_control', 'VBR');
  setSetting('Output', 'Recbitrate', options.obsKBitRate * 1024);

  // Without this, we'll never exceed the default max which is 5000.
  setSetting('Output', 'Recmax_bitrate', 300000);
  
  // FPS for the output video file. 
  setSetting('Video', 'FPSCommon', options.obsFPS);

  console.debug('[OBS] OBS Configured');
}

/**
 * Configure the recording encoder for OBS
 */
const setObsRecEncoder = (options: RecorderOptionsType): void => {
  const availableEncoders = getObsAvailableRecEncoders();

  let encoder = options.obsRecEncoder;
  let autoPickEncoder = (!encoder || encoder === 'auto');

  console.debug("[OBS] Available encoders", inspectObject(availableEncoders));

  if (!autoPickEncoder && !availableEncoders.includes(encoder)) {
    console.debug(`[OBS] Configured encoder '${encoder}' is not available.`);
    autoPickEncoder = true;
  }

  if (autoPickEncoder) {
    encoder = availableEncoders.slice(-1)[0];
    console.debug(`[OBS] Selecting encoder automatically: ${encoder}.`);
  }

  setSetting('Output', 'RecEncoder', encoder);
}

/*
* Get information about primary display
* @param zero starting monitor index
*/
const displayInfo = (displayIndex: number): OurDisplayType | undefined => {
  const displays = getAvailableDisplays();
  console.info("[OBS] Displays:", displays);

  return displays.find(d => d.index === displayIndex);
}

/**
 * Find the resolution from `resolutions` which closest match the one given in
 * `target`.
 */
const getClosestResolution = (resolutions: string[], target: Size): string => {
  // Split string like '2560x1440' into [2560, 1440]
  const numericResolutions = resolutions.map((v: string) => {
    return v.split('x').map(v => parseInt(v, 10));
  });

  // Create an array of values with the target resolution subtracted.
  // We'll end up with an array where one element has a very low number,
  // which is at the index we're after.
  //
  // We multiply width/height by a different number to avoid having mirrored
  // resolutions (1080x1920 vs 1920x1080) have the same sorting value.
  const indexArray = numericResolutions.map(v => {
      return Math.abs(((target.width - v[0]) * 2) + ((target.height - v[1]) * 4));
  });

  // Find the minimum value from the indexing array. This value will
  // be at the index in `indexArray` matching the one in `resolutions`
  // where we'll find the closest matching resolution of the available ones.
  const minValue = Math.min(...indexArray);

  // At the position of `minValue` in `indexArray`, we'll find the actual
  // resolution in `resolutions` at the same index.
  return resolutions[indexArray.indexOf(minValue)];
};

/*
* Given a none-whole monitor resolution, find the closest one that
* OBS supports and set the corospoding setting in Video.Untitled.{paramString}
*
* @remarks
* Useful when windows scaling is not set to 100% (125%, 150%, etc) on higher resolution monitors,
* meaning electron screen.getAllDisplays() will return a none integer scaleFactor, causing
* the calucated monitor resolution to be none-whole.
*
* @throws
* Throws an error if no matching resolution is found.
*/
const setOBSVideoResolution = (res: Size, paramString: string) => {
  const availableResolutions = getAvailableValues('Video', 'Untitled', paramString);
  const closestResolution = getClosestResolution(availableResolutions, res);

  setSetting('Video', paramString, closestResolution);
};

/*
* setupScene
*/
const setupScene = (options: RecorderOptionsType): void => {
  const outputResolution = parseResolutionsString(options.obsOutputResolution);
  let baseResolution: Size;

  setOBSVideoResolution(outputResolution, 'Output');

  let videoSource: IInput;

  switch (options.obsCaptureMode) {
    case 'monitor_capture':
      // Correct the monitorIndex. In config we start a 1 so it's easy for users.
      const monitorIndexFromZero = options.monitorIndex - 1;
      console.info("[OBS] monitorIndexFromZero:", monitorIndexFromZero);
      const selectedDisplay = displayInfo(monitorIndexFromZero);
      if (!selectedDisplay) {
        throw Error(`[OBS] No such display with index: ${monitorIndexFromZero}.`)
      }

      baseResolution = selectedDisplay.physicalSize;

      videoSource = createMonitorCaptureSource(monitorIndexFromZero);
      break;

    case 'game_capture':
      baseResolution = outputResolution;
      videoSource = createGameCaptureSource();
      break;

    default:
      throw Error(`[OBS] Invalid capture mode: ${options.obsCaptureMode}`);
  }

  setOBSVideoResolution(baseResolution, 'Base');

  scene = osn.SceneFactory.create('main');
  const sceneItem = scene.add(videoSource);
  sceneItem.scale = { x: 1.0, y: 1.0 };

  console.log(`[OBS] Configured video input source with mode '${options.obsCaptureMode}'`, inspectObject(videoSource.settings))

  watchVideoSourceSize(sceneItem, videoSource, baseResolution);
}

/**
 * Create and return a game capture video source ('game_capture')
 */
const createGameCaptureSource = (): IInput => {
  const videoSource = osn.InputFactory.create('game_capture', 'Game Capture');
  const settings = videoSource.settings;

  settings['capture_cursor'] = true;
  settings['capture_mode'] = 'window';
  settings['allow_transparency'] = true;
  settings['priority'] = 1; // Window title must match
  settings['window'] = 'World of Warcraft:GxWindowClass:Wow.exe';

  videoSource.update(settings);
  videoSource.save();

  return videoSource;
};

/**
 * Create and return a monitor capture video source ('monitor_capture')
 */
const createMonitorCaptureSource = (monitorIndex: number): IInput => {
  const videoSource = osn.InputFactory.create('monitor_capture', 'Monitor Capture');
  const settings = videoSource.settings;

  settings['monitor'] = monitorIndex;

  videoSource.update(settings);
  videoSource.save();

  return videoSource;
};

/**
 * Watch the video input source for size changes and adjust the scene item
 * scaling accordingly.
 *
 * @param sceneItem       Scene item as returned from `IScene.add()`
 * @param sourceName      Video input source
 * @param baseResolution  Resolution used as base for scaling the video source
 */
const watchVideoSourceSize = (sceneItem: ISceneItem, videoSource: IInput, baseResolution: Size): void => {
  clearInterval(timerVideoSourceSize);
  timerVideoSourceSize = setInterval(() => {
    const result = { width: videoSource.width, height: videoSource.height };

    if (result.width === 0 || result.height === 0) {
      return;
    }

    if (lastVideoSourceSize && result.width === lastVideoSourceSize.width && result.height === lastVideoSourceSize.height) {
      return;
    }

    lastVideoSourceSize = result;

    const scaleFactor = baseResolution.width / result.width;
    sceneItem.scale = { x: scaleFactor, y: scaleFactor };

    const logDetails = {
      base: baseResolution,
      input: result,
      scale: sceneItem.scale,
    };

    console.log("[OBS] Adjusting scene item scale due to video input source size change", inspectObject(logDetails));
  }, 5000);
};

/*
* setupSources
*/
const setupSources = (scene: any, audioInputDeviceId: string, audioOutputDeviceId: string ) => {
  clearSources();

  osn.Global.setOutputSource(1, scene);

  setSetting('Output', 'Track1Name', 'Mixed: all sources');
  let currentTrack = 2;

  getAvailableAudioInputDevices()
    .forEach(device => {
      const source = osn.InputFactory.create('wasapi_input_capture', 'mic-audio', { device_id: device.id });
      setSetting('Output', `Track${currentTrack}Name`, device.name);
      source.audioMixers = 1 | (1 << currentTrack-1); // Bit mask to output to only tracks 1 and current track
      source.muted = audioInputDeviceId === 'none' || (audioInputDeviceId !== 'all' && device.id !== audioInputDeviceId);
      console.log(`[OBS] Selecting audio input device: ${device.name} ${source.muted ? ' [MUTED]' : ''}`)
      osn.Global.setOutputSource(currentTrack, source);
      source.release()
      currentTrack++;
    });

  getAvailableAudioOutputDevices()
    .forEach(device => {
      const source = osn.InputFactory.create('wasapi_output_capture', 'desktop-audio', { device_id: device.id });
      setSetting('Output', `Track${currentTrack}Name`, device.name);
      source.audioMixers = 1 | (1 << currentTrack-1); // Bit mask to output to only tracks 1 and current track
      source.muted = audioOutputDeviceId === 'none' || (audioOutputDeviceId !== 'all' && device.id !== audioOutputDeviceId);
      console.log(`[OBS] Selecting audio output device: ${device.name} ${source.muted ? ' [MUTED]' : ''}`)
      osn.Global.setOutputSource(currentTrack, source);
      source.release()
      currentTrack++;
    });

  setSetting('Output', 'RecTracks', parseInt('1'.repeat(currentTrack-1), 2)); // Bit mask of used tracks: 1111 to use first four (from available six)
}

/**
 * Clear all sources from the global output of OBS
 */
 const clearSources = (): void => {
  console.log("[OBS] Removing all output sources")

  // OBS allows a maximum of 64 output sources
  for (let index = 1; index < 64; index++) {
    const src: ISource = osn.Global.getOutputSource(index);
    if (src !== undefined) {
      setSetting('Output', `Track${index}Name`, '');
      osn.Global.setOutputSource(index, null);
      src.release();
      src.remove();
    }
  }

  setSetting('Output', 'RecTracks', 0); // Bit mask of used tracks: 1111 to use first four (from available six)
};

/*
* start
*/
const start = async () => {
  if (!obsInitialized) throw Error("OBS not initialised");
  console.log("[OBS] obsRecorder: start");
  osn.NodeObs.OBS_service_startRecording();
  await assertNextSignal("start");
}

/*
* stop
*/
const stop = async () => {
  console.log("[OBS] obsRecorder: stop");
  osn.NodeObs.OBS_service_stopRecording();
  await assertNextSignal("stopping");
  await assertNextSignal("stop");
  await assertNextSignal("wrote");
}

/*
* shutdown
*/
const shutdown = () => {
  if (!obsInitialized) {
    console.debug('[OBS]  OBS is already shut down!');
    return false;
  }

  console.debug('[OBS]  Shutting down OBS...');

  try {
    osn.NodeObs.OBS_service_removeCallback();
    osn.NodeObs.IPC.disconnect();
    obsInitialized = false;
  } catch(e) {
    throw Error('Exception when shutting down OBS process' + e);
  }

  console.debug('[OBS]  OBS shutdown successfully');

  return true;
}

/*
* setSetting
*/
const setSetting = (category: any, parameter: any, value: any) => {
  let oldValue;

  console.debug('[OBS] OBS: setSetting', category, parameter, value);

  // Getting settings container
  const settings = osn.NodeObs.OBS_settings_getSettings(category).data;

  settings.forEach((subCategory: any) => {
    subCategory.parameters.forEach((param: any) => {
      if (param.name === parameter) {        
        oldValue = param.currentValue;
        param.currentValue = value;
      }
    });
  });

  // Saving updated settings container
  if (value != oldValue) {
    osn.NodeObs.OBS_settings_saveSettings(category, settings);
  }
}

/*
* getAvailableValues
*/
const getAvailableValues = (category: any, subcategory: any, parameter: any) => {
  const categorySettings = osn.NodeObs.OBS_settings_getSettings(category).data;

  if (!categorySettings) {
    console.warn(`[OBS] There is no category ${category} in OBS settings`);
    return;
  }

  const subcategorySettings = categorySettings.find((sub: any) => sub.nameSubCategory === subcategory);

  if (!subcategorySettings) {
    console.warn(`[OBS] There is no subcategory ${subcategory} for OBS settings category ${category}`);
    return;
  }

  const parameterSettings = subcategorySettings.parameters.find((param: any) => param.name === parameter);
  
  if (!parameterSettings) {
    console.warn(`[OBS] There is no parameter ${parameter} for OBS settings category ${category}.${subcategory}`);
    return;
  }

  return parameterSettings.values.map( (value: any) => Object.values(value)[0]);
}

/**
 * Simply return a list of available resolutions from OBS for 'Base' and 'Output
 */
const getObsResolutions = (): any => {
  return {
    'Base':   getAvailableValues('Video', 'Untitled', 'Base'),
    'Output': getAvailableValues('Video', 'Untitled', 'Output')
  };
}

/*
* Assert a signal from OBS is as expected, if it is not received
* within 5 seconds or is not as expected then throw an error. 
*/
const assertNextSignal = async (value: string) => {

  // Don't wait more than 5 seconds for the signal.
  let signalInfo = await Promise.race([
    waitQueue.shift(), 
    new Promise((_, reject) => {
      setTimeout(reject, 5000, "OBS didn't signal " + value + " in time")}
    )
  ]);

  // Assert the type is as expected.
  if (signalInfo.type !== "recording") {
    console.error("[OBS] " + signalInfo);
    console.error("[OBS] OBS signal type unexpected", signalInfo.signal, value);
    throw Error("OBS behaved unexpectedly (2)");
  }

  // Assert the signal value is as expected.
  if (signalInfo.signal !== value) {
    console.error("[OBS] " + signalInfo);
    console.error("[OBS] OBS signal value unexpected", signalInfo.signal, value);
    throw Error("OBS behaved unexpectedly (3)");
  }

  console.debug("[OBS] Asserted OBS signal:", value);
}

/**
 * Return the full path of the file that was last recorded from OBS
 */
const getObsLastRecording = (): string => {
  return path.resolve(osn.NodeObs.OBS_service_getLastRecording());
};

const getObsAvailableRecEncoders = (): string[] => {
  return getAvailableValues('Output', 'Recording', 'RecEncoder');
};

let displayId = 'display1';

const setupPreview = (window: BrowserWindow, bounds: Rectangle) => {
  osn.NodeObs.OBS_content_createSourcePreviewDisplay(
    window.getNativeWindowHandle(),
    scene.name,
    displayId,
  );
  osn.NodeObs.OBS_content_setShouldDrawUI(displayId, false);
  osn.NodeObs.OBS_content_setPaddingSize(displayId, 0);
  // Match padding color with main window background color
  //osn.NodeObs.OBS_content_setPaddingColor(displayId, 255, 255, 255);

  return resizePreview(bounds);
}

let initY = 0
const resizePreview = (bounds: Rectangle) => {
  const aspectRatio = bounds.width / bounds.height;
  const displayWidth = Math.floor(bounds.width);
  const displayHeight = Math.round(displayWidth / aspectRatio);
  const displayX = Math.floor(bounds.x);
  const displayY = Math.floor(bounds.y);
  if (initY === 0) {
    initY = displayY
  }
  osn.NodeObs.OBS_content_resizeDisplay(displayId, displayWidth, displayHeight);
  osn.NodeObs.OBS_content_moveDisplay(displayId, displayX, displayY);
  console.log({
    bounds,
    aspectRatio,
    displayWidth,
    displayHeight,
    displayX,
    displayY,
  });

  return { height: displayHeight }
}

export {
  initialize,
  start,
  stop,
  shutdown,
  reconfigure,
  getObsResolutions,
  getObsLastRecording,
  getObsAvailableRecEncoders,
  setupPreview,
  resizePreview,
}
