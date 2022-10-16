import { fixPathWhenPackaged, getAvailableDisplays } from "./util";
import WaitQueue from 'wait-queue';
import { getAvailableAudioInputDevices, getAvailableAudioOutputDevices } from "./obsAudioDeviceUtils";
import { RecorderOptionsType } from "./recorder";
import { Size } from "electron";
import path from 'path';
import { inspectObject, parseResolutionsString } from "./helpers";
import { ISceneItem, IScene, IInput } from "obs-studio-node";
import { OurDisplayType } from "./types";
import { ISource } from "obs-studio-node";
const waitQueue = new WaitQueue<any>();
const osn = require("obs-studio-node");
const { v4: uuid } = require('uuid');


export default class ObsRecorder {
  static _instance: ObsRecorder;

  private _obsInitialized = false;
  // Timer for periodically checking the size of the video source
  private _timerVideoSourceSize: any;
  // Previous size of the video source as checked by checkVideoSourceSize()
  private _lastVideoSourceSize: Size | undefined;
  private _scene: IScene | undefined;
  private _options: RecorderOptionsType;

  /*
  * Init the library, launch OBS Studio instance, configure it, set up sources and scene
  */
  private constructor(options: RecorderOptionsType) {
    this._options = options;

    this.initOBS();
    this.reconfigure();

    this._obsInitialized = true;
  }

  /*
  * Reconfigure the recorder without destroying it.
  */
  reconfigure(options: RecorderOptionsType | null = null) {
    if (options) {
      this._options = options;
    }

    this.configureOBS();
    this.setupScene();
    this.setupSources();
  }

  /*
  * initOBS
  */
  initOBS() {
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

      this.shutdown();

      throw Error(errorMessage);
    }

    osn.NodeObs.OBS_service_connectOutputSignals((signalInfo: any) => {
      waitQueue.push(signalInfo);
    });

    console.debug('[OBS] OBS initialized');
  }

  /**
   * configureOBS
   */
  configureOBS() {
    console.debug('[OBS] Configuring OBS');
    ObsRecorder.setSetting('Output', 'Mode', 'Advanced');
    const availableEncoders = getAvailableValues('Output', 'Recording', 'RecEncoder');

    // Get a list of available encoders, select the last one.
    console.debug("[OBS] Available encoder: " + JSON.stringify(availableEncoders));
    const selectedEncoder = availableEncoders.slice(-1)[0] || 'x264';
    console.debug("[OBS] Selected encoder: " + selectedEncoder);
    ObsRecorder.setSetting('Output', 'RecEncoder', selectedEncoder);

    // Set output path and video format.
    ObsRecorder.setSetting('Output', 'RecFilePath', options.bufferStorageDir);
    ObsRecorder.setSetting('Output', 'RecFormat', 'mp4');

    // VBR is "Variable Bit Rate", read about it here:
    // https://blog.mobcrush.com/using-the-right-rate-control-in-obs-for-streaming-or-recording-4737e22895ed
    ObsRecorder.setSetting('Output', 'Recrate_control', 'VBR');
    ObsRecorder.setSetting('Output', 'Recbitrate', options.obsKBitRate * 1024);

    // Without this, we'll never exceed the default max which is 5000.
    ObsRecorder.setSetting('Output', 'Recmax_bitrate', 300000);
    
    // FPS for the output video file. 
    ObsRecorder.setSetting('Video', 'FPSCommon', options.obsFPS);

    console.debug('[OBS] OBS Configured');
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
  setOBSVideoResolution(res: Size, paramString: string): void {
    const availableResolutions = ObsRecorder.getAvailableValues('Video', 'Untitled', paramString);
    const closestResolution = getClosestResolution(availableResolutions, res);

    ObsRecorder.setSetting('Video', paramString, closestResolution);
  }

  /**
   * setupScene
   */
  setupScene(): void {
    const outputResolution = parseResolutionsString(this._options.obsOutputResolution);
    let baseResolution: Size;

    this.setOBSVideoResolution(outputResolution, 'Output');

    let videoSource: IInput;

    switch (this._options.obsCaptureMode) {
      case 'monitor_capture':
        // Correct the monitorIndex. In config we start a 1 so it's easy for users.
        const monitorIndexFromZero = this._options.monitorIndex - 1;
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
        throw Error(`[OBS] Invalid capture mode: ${this._options.obsCaptureMode}`);
    }

    setOBSVideoResolution(baseResolution, 'Base');

    const scene: IScene = osn.SceneFactory.create('main');
    const sceneItem = scene.add(videoSource);
    sceneItem.scale = { x: 1.0, y: 1.0 };

    console.log(`[OBS] Configured video input source with mode '${this._options.obsCaptureMode}'`, inspectObject(videoSource.settings))

    watchVideoSourceSize(sceneItem, videoSource, baseResolution);

    return scene;
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

  /**
   * setupSources
   */
   setupSources() {
    this.clearSources();

    osn.Global.setOutputSource(1, this._scene);

    ObsRecorder.setSetting('Output', 'Track1Name', 'Mixed: all sources');
    let currentTrack = 2;

    getAvailableAudioInputDevices()
      .forEach(device => {
        const source = osn.InputFactory.create('wasapi_input_capture', 'mic-audio', { device_id: device.id });
        ObsRecorder.setSetting('Output', `Track${currentTrack}Name`, device.name);
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
        ObsRecorder.setSetting('Output', `Track${currentTrack}Name`, device.name);
        source.audioMixers = 1 | (1 << currentTrack-1); // Bit mask to output to only tracks 1 and current track
        source.muted = audioOutputDeviceId === 'none' || (audioOutputDeviceId !== 'all' && device.id !== audioOutputDeviceId);
        console.log(`[OBS] Selecting audio output device: ${device.name} ${source.muted ? ' [MUTED]' : ''}`)
        osn.Global.setOutputSource(currentTrack, source);
        source.release()
        currentTrack++;
      });

      ObsRecorder.setSetting('Output', 'RecTracks', parseInt('1'.repeat(currentTrack-1), 2)); // Bit mask of used tracks: 1111 to use first four (from available six)
  }

  /**
   * Clear all sources from the global output of OBS
   */
  clearSources(): void {
    console.log("[OBS] Removing all output sources")

    // OBS allows a maximum of 64 output sources
    for (let index = 1; index < 64; index++) {
      const src: ISource = osn.Global.getOutputSource(index);
      if (src !== undefined) {
        ObsRecorder.setSetting('Output', `Track${index}Name`, '');
        osn.Global.setOutputSource(index, null);
        src.release();
        src.remove();
      }
    }

    ObsRecorder.setSetting('Output', 'RecTracks', 0); // Bit mask of used tracks: 1111 to use first four (from available six)
  };

  /**
   * start
   */
  async start() {
    console.log("[OBS] obsRecorder: start");
    osn.NodeObs.OBS_service_startRecording();

    await ObsRecorder.assertNextSignal("start");
  }

  /**
   * stop
   */
  async stop() {
    console.log("[OBS] obsRecorder: stop");
    osn.NodeObs.OBS_service_stopRecording();

    await ObsRecorder.assertNextSignal("stopping");
    await ObsRecorder.assertNextSignal("stop");
    await ObsRecorder.assertNextSignal("wrote");
  }

  /**
   * shutdown
   */
  shutdown() {
    console.debug('[OBS]  Shutting down OBS...');

    try {
      osn.NodeObs.OBS_service_removeCallback();
      osn.NodeObs.IPC.disconnect();
    } catch(e) {
      throw Error('Exception when shutting down OBS process' + e);
    }

    console.debug('[OBS]  OBS shutdown successfully');
  }

  /*
  * setSetting
  */
  static setSetting(category: any, parameter: any, value: any) {
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

  /**
   * getAvailableValues
   */
  static getAvailableValues(category: any, subcategory: any, parameter: any): any[] {
    const categorySettings = osn.NodeObs.OBS_settings_getSettings(category).data;

    if (!categorySettings) {
      console.warn(`[OBS] There is no category ${category} in OBS settings`);
      return [];
    }

    const subcategorySettings = categorySettings.find((sub: any) => sub.nameSubCategory === subcategory);

    if (!subcategorySettings) {
      console.warn(`[OBS] There is no subcategory ${subcategory} for OBS settings category ${category}`);
      return [];
    }

    const parameterSettings = subcategorySettings.parameters.find((param: any) => param.name === parameter);
    
    if (!parameterSettings) {
      console.warn(`[OBS] There is no parameter ${parameter} for OBS settings category ${category}.${subcategory}`);
      return [];
    }

    return parameterSettings.values.map( (value: any) => Object.values(value)[0]);
  }

  /**
   * Assert a signal from OBS is as expected, if it is not received
   * within 5 seconds or is not as expected then throw an error. 
   */
  static async assertNextSignal(value: string) {
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
   * Simply return a list of available resolutions from OBS for 'Base' and 'Output
   */
  static getObsResolutions(): any {
    return {
      Base:   getAvailableValues('Video', 'Untitled', 'Base'),
      Output: getAvailableValues('Video', 'Untitled', 'Output')
    };
  }

  /**
   * Return the full path of the file that was last recorded from OBS
   */
  static getObsLastRecording(): string {
    return path.resolve(osn.NodeObs.OBS_service_getLastRecording());
  }
}