import { fixPathWhenPackaged, getAvailableDisplays } from "./util";
import WaitQueue from 'wait-queue';
import { getAvailableAudioInputDevices, getAvailableAudioOutputDevices } from "./obsAudioDeviceUtils";
import { RecorderOptionsType } from "./recorder";
import { ObsSignal, OurDisplayType } from "./types";
import { Size } from "electron";
import { v4 as uuid } from 'uuid';
const path = require('path');
const osn = require("obs-studio-node");

const obsInitErrors: { [key: string]: string } = {
  '-2': 'DirectX could not be found on your system. Please install the latest version of DirectX for your machine here <https://www.microsoft.com/en-us/download/details.aspx?id=35?> and try again.',
  '-5': 'Failed to initialize OBS. Your video drivers may be out of date, or Streamlabs OBS may not be supported on your system.',
};

export default class ObsRecorder {
  /**
   * Holds the singleton instance for this class as created via
   * `ObsRecorder.getInstance()`.
   */
  private static _instance: ObsRecorder;
  private _options: RecorderOptionsType;
  private _initialized: boolean = false;
  private _signalQueue = new WaitQueue<any>();
  private _obsEncoders: string[] = [];
  private _scene: any = null;

  /**
   * Init the library, launch OBS Studio instance, configure it, set up sources and scene.
   * Constructor is intentionally private to prevent instantiation outside of `getInstance()`.
   */
  private constructor(options: RecorderOptionsType) {
    this._options = options;

    this.initOBS();

    this._obsEncoders = this.getObsEncoders();
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Get the instance of the class as a singletone.
   * There should only ever be one instance created and his method faciliates that.
   */
  static getInstance(options?: RecorderOptionsType): ObsRecorder {
    if (!ObsRecorder._instance) {
      if (!options) {
        throw Error('[ObsRecorder] Cannot instantiate instance of ObsRecorder without options.')
      }

      ObsRecorder._instance = new ObsRecorder(options);
    }

    if (options) {
      ObsRecorder._instance.reconfigure();
    }

    return ObsRecorder._instance;
  }

  /*
   * Reconfigure the recorder without destroying it.
   */
  reconfigure(options?: RecorderOptionsType): void {
    if (options)  {
      this._options = options;
    }

    this.configureOBS();
    this.setupScene();
    this.setupSources();
  }

  /**
   * Return an array of available output encoders from OBS½
   */
  getObsEncoders(): string[] {
    return this.setConfigValues('Output', 'Recording', 'RecEncoder');
  }

  /*
   * configureOBS
   */
  private configureOBS(): void {
    console.debug('[ObsRecorder] Configuring OBS');

    const obsEncoder = this._obsEncoders.at(-1) || 'x264';

    this.setConfigValue('Output', 'Mode', 'Advanced');
    this.setConfigValue('Output', 'RecEncoder', obsEncoder);

    // Set output path and video format.
    this.setConfigValue('Output', 'RecFilePath', this._options.bufferStorageDir);
    this.setConfigValue('Output', 'RecFormat', 'mp4');

    if (obsEncoder.toLowerCase().includes("amf")) {
      // For AMF encoders, can't set 'lossless' bitrate.
      // It interprets it as zero and fails to start.
      // See https://github.com/aza547/wow-recorder/issues/40.
      this.setConfigValue('Output', 'Recbitrate', 50000);
    }
    else {
      // No idea how this works, but it does.
    // No idea how this works, but it does.
      // No idea how this works, but it does.
      this.setConfigValue('Output', 'Recbitrate', 'Lossless');
    }

    this.setConfigValue('Output', 'Recmax_bitrate', 300000);
    this.setConfigValue('Video', 'FPSCommon', 60);

    console.debug('[ObsRecorder] OBS Configured');
  }

  /**
   * Set the resolution for OBS for the given `paramString` sub-category
   */
  private setOBSVideoResolution(res: Size, paramString: string): void {
    const availableResolutions = this.setConfigValues('Video', 'Untitled', paramString);
    const closestResolution = this.getClosestResolution(availableResolutions, res);

    this.setConfigValue('Video', paramString, closestResolution);
  }

  /*
  * setupScene
  */
  private setupScene(): void {
    // Correct the monitorIndex. In config we start a 1 so it's easy for users.
    const monitorIndexFromZero = this._options.monitorIndex - 1;
    console.info("[ObsRecorder] monitorIndexFromZero:", monitorIndexFromZero);
    const selectedDisplay = this.displayInfo(monitorIndexFromZero);
    if (!selectedDisplay) {
      throw Error(`[ObsRecorder] No such display with index: ${monitorIndexFromZero}.`)
    }

    this.setOBSVideoResolution(selectedDisplay.physicalSize, 'Base');

    // TODO: Output should eventually be moved into a setting field to be scaled down. For now it matches the monitor resolution.
    this.setOBSVideoResolution(selectedDisplay.physicalSize, 'Output');

    const videoSource = osn.InputFactory.create('monitor_capture', 'desktop-video');

    // // Update source settings:
    const settings = videoSource.settings;
    settings['monitor'] = monitorIndexFromZero;
    videoSource.update(settings);
    videoSource.save();

    // A scene is necessary here to properly scale captured screen size to output video size
    this._scene = osn.SceneFactory.create('test-scene');
    const sceneItem = this._scene.add(videoSource);
    sceneItem.scale = { x: 1.0, y: 1.0 };
  }

  /*
   * start
   */
  async start(): Promise<void> {
    if (!this._initialized) {
      throw Error("OBS not initialised")
    }

    console.log("[ObsRecorder] Start recording");

    osn.NodeObs.OBS_service_startRecording();
    this.assertNextSignal(ObsSignal.Start);
  }

  /*
   * stop
   */
  async stop(): Promise<void> {
    console.log("[ObsRecorder] Stop recording");

    osn.NodeObs.OBS_service_stopRecording();
    this.assertNextSignal(ObsSignal.Stopping);
    this.assertNextSignal(ObsSignal.Stop);
    this.assertNextSignal(ObsSignal.Wrote);
  }

  /*
   * shutdown
   */
  shutdown() {
    if (!this._initialized) {
      console.debug('[ObsRecorder] Already shut down!');
      return false;
    }

    console.debug('[ObsRecorder] Shutting down');

    try {
      osn.NodeObs.OBS_service_removeCallback();
      osn.NodeObs.IPC.disconnect();
      this._initialized = false;
    } catch(e) {
      throw Error('Exception when shutting down OBS process' + e);
    }

    console.debug('[ObsRecorder] Shutdown successfully');

    return true;
  }

  /*
  * setupSources
  */
  setupSources(): void {
    if (!this._scene) {
      throw Error('[ObsRecorder] No scene exists; cannot continue');
    }

    osn.Global.setOutputSource(1, this._scene);

    const { audioInputDeviceId, audioOutputDeviceId } = this._options;

    this.setConfigValue('Output', 'Track1Name', 'Mixed: all sources');
    let currentTrack = 2;

    getAvailableAudioInputDevices()
      .forEach(device => {
        const source = osn.InputFactory.create('wasapi_input_capture', 'mic-audio', { device_id: device.id });
        this.setConfigValue('Output', `Track${currentTrack}Name`, device.name);
        source.audioMixers = 1 | (1 << currentTrack-1); // Bit mask to output to only tracks 1 and current track
        source.muted = audioInputDeviceId === 'none' || (audioInputDeviceId !== 'all' && device.id !== audioInputDeviceId);
        console.log(`[ObsRecorder] Selecting audio input device: ${device.name} ${source.muted ? ' [MUTED]' : ''}`)
        osn.Global.setOutputSource(currentTrack, source);
        source.release()
        currentTrack++;
      });

    getAvailableAudioOutputDevices()
      .forEach(device => {
        const source = osn.InputFactory.create('wasapi_output_capture', 'desktop-audio', { device_id: device.id });
        this.setConfigValue('Output', `Track${currentTrack}Name`, device.name);
        source.audioMixers = 1 | (1 << currentTrack-1); // Bit mask to output to only tracks 1 and current track
        source.muted = audioOutputDeviceId === 'none' || (audioOutputDeviceId !== 'all' && device.id !== audioOutputDeviceId);
        console.log(`[ObsRecorder] Selecting audio output device: ${device.name} ${source.muted ? ' [MUTED]' : ''}`)
        osn.Global.setOutputSource(currentTrack, source);
        source.release()
        currentTrack++;
      });

    this.setConfigValue('Output', 'RecTracks', parseInt('1'.repeat(currentTrack-1), 2)); // Bit mask of used tracks: 1111 to use first four (from available six)
  }

  /*
   * Assert a signal from OBS is as expected, if it is not received
   * within 5 seconds or is not as expected then throw an error.
   */
  private async assertNextSignal(value: string): Promise<void> {
    // Don't wait more than 5 seconds for the signal.
    let signalInfo = await Promise.race([
      this._signalQueue.shift(),
      new Promise((_, reject) => {
        setTimeout(reject, 5000, "OBS didn't signal " + value + " in time")}
      )
    ]);

    // Assert the type is as expected.
    if (signalInfo.type !== "recording") {
      console.error("[ObsRecorder] " + signalInfo);
      console.error("[ObsRecorder] Signal type unexpected", signalInfo.signal, value);
      throw Error("OBS behaved unexpectedly (2)");
    }

    // Assert the signal value is as expected.
    if (signalInfo.signal !== value) {
      console.error("[ObsRecorder] " + signalInfo);
      console.error("[ObsRecorder] Signal value unexpected", signalInfo.signal, value);
      throw Error("OBS behaved unexpectedly (3)");
    }

    console.debug("[ObsRecorder] Asserted OBS signal:", value);
  }

  /*
   * Initialize the OBS IPC connector
   */
  private initOBS(): void {
    console.debug('[ObsRecorder] Initializing OBS');

    osn.NodeObs.IPC.host(`warcraft-recorder-${uuid()}`);
    osn.NodeObs.SetWorkingDirectory(fixPathWhenPackaged(path.join(__dirname,'../../', 'node_modules', 'obs-studio-node')));

    const obsDataPath = fixPathWhenPackaged(path.join(__dirname, 'osn-data')); // OBS Studio configs and logs
    // Arguments: locale, path to directory where configuration and logs will be stored, your application version
    const initResult = osn.NodeObs.OBS_API_initAPI('en-US', obsDataPath, '1.0.0');

    if (initResult !== 0) {
      const errorMessage = obsInitErrors[initResult.toString()] || `An unknown error #${initResult} was encountered while initializing OBS.`;

      console.error('[ObsRecorder] OBS init failure', errorMessage);

      this.shutdown();

      throw Error(errorMessage);
    }

    osn.NodeObs.OBS_service_connectOutputSignals((signalInfo: any) => {
      this._signalQueue.push(signalInfo);
    });

    this._initialized = true;

    console.debug('[ObsRecorder] OBS initialized');
  }

  /*
  * Get information about primary display
  */
  private displayInfo(displayIndex: number): OurDisplayType | undefined {
    const displays = getAvailableDisplays();
    console.info("[ObsRecorder] Displays:", displays);

    return displays.find(d => d.index === displayIndex);
  }

  /**
   * Given a none-whole monitor resolution, find the closest one that
   * OBS supports and set the corospoding setting in `Video.Untitled.{paramString}`
   *
   * @remarks
   * Useful when windows scaling is not set to 100% (125%, 150%, etc) on higher resolution monitors,
   * meaning electron `screen.getAllDisplays()` will return a none integer `scaleFactor`, causing
   * the calucated monitor resolution to be none-whole.
   */
  private getClosestResolution(resolutions: string[], target: Size): string {
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
  }

  /**
   * setSetting
   */
  setConfigValue(category: any, parameter: any, value: any): void {
    let oldValue;

    console.debug('[ObsRecorder] OBS: setSetting', category, parameter, value);

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
   * Get a list of possible configuration values for a given category and subcategory.
   */
  private setConfigValues(category: any, subcategory: any, parameter: any): any {
    const categorySettings = osn.NodeObs.OBS_settings_getSettings(category).data;

    if (!categorySettings) {
      console.warn(`[ObsRecorder] There is no category ${category} in OBS settings`);
      return;
    }

    const subcategorySettings = categorySettings.find((sub: any) => sub.nameSubCategory === subcategory);

    if (!subcategorySettings) {
      console.warn(`[ObsRecorder] There is no subcategory ${subcategory} for OBS settings category ${category}`);
      return;
    }

    const parameterSettings = subcategorySettings.parameters.find((param: any) => param.name === parameter);

    if (!parameterSettings) {
      console.warn(`[ObsRecorder] There is no parameter ${parameter} for OBS settings category ${category}.${subcategory}`);
      return;
    }

    return parameterSettings.values.map((value: any) => Object.values(value)[0]);
  }
};
