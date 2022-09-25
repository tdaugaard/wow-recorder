import ElectronStore from "electron-store";
import { ipcMain } from "electron";
import path from "path";
import { EventEmitter } from "stream";

type ConfigurationSchema = {
    storagePath: string,
    bufferPath?: string,
    retailLogPath: string,
    classicLogPath?: string,
    maxStorage: number,
    monitorIndex: number,
    selectedCategory: number,
    audioInputDevice?: string,
    audioOutputDevice?: string,
    minEncounterDuration: number,
    startUp?: boolean,
};

/**
 * 
 */
const schema = {
    storagePath: {
        description: 'Filesystem path where finalized videos are stored',
        type: 'string',
        default: '',
    },
    bufferPath: {
        description: 'Filesystem path where temporary videos files are stored',
        type: 'string',
        default: '',
    },
    retailLogPath: {
        description: 'Filesystem path where WoW Retail combat logs are stored',
        type: 'string',
        default: '',
    },
    classicLogPath: {
        description: 'Filesystem path where WoW Classic combat logs are stored',
        type: 'string',
        default: '',
    },
    maxStorage: {
        description: 'Maximum allowed storage, in GB, that the application will consume for non-protected video files',
        type: 'integer',
        default: 20,
        minimum: 1,
    },
    monitorIndex: {
        description: 'The one-based index of the display to record',
        type: 'integer',
        default: 1,
        minimum: 1,
        maximum: 4,        
    },
    selectedCategory: {
        description: 'Last selected video category in the UI',
        type: 'integer',
        default: 0,
    },
    audioInputDevice: {
        description: 'Audio input device to be included in the recording',
        type: 'string',
        default: 'all',
    },
    audioOutputDevice: {
        description: 'Audio output device to be included in the recording',
        type: 'string',
        default: 'all',
    },
    minEncounterDuration: {
        description: 'Minimum boss encounter duration, in seconds, in order for it to not be discarded [Raids only]',
        type: 'integer',
        default: 15,
        maximum: 10000,
    },
    startUp: {
        description: 'Whether the application starts on Windows start-up',
        type: 'boolean',
        default: false,
    },
};

export default class ConfigService extends EventEmitter {
    private _store = new ElectronStore<ConfigurationSchema>({schema, name: 'config-v2'});

    constructor() {
        super();

        this._store.onDidAnyChange((newValue: any, oldValue: any) => {
            this.emit('configChanged', oldValue, newValue);
        });

        // Update the default for buffer-storage-path whenever 'storage-path' changes
        this._store.onDidChange('storagePath', (newValue: any) => this.updateDefaults('storagePath', newValue));

        /**
         * Getter and setter config listeners. 
         */
        ipcMain.on('config', (event, args) => {
            const [fn, key] = args;

            if (fn === 'get') {
                const value = this.get(key);
                console.log('[ConfigService] Get from config store:', key, value);
                event.returnValue = value;
            } else
            if (fn === 'set') {
                const value = args[2];
                this.set(key, value);
                console.log('[ConfigService] Set in config store:', key, value);
            }
        });
    }

    validate(): boolean {
        const storagePath = this.get('storagePath');
        if (storagePath) {
            this.updateDefaults('storagePath', storagePath);
        }

        if (!this.get('storagePath')) {
            console.warn('[ConfigService] Validation failed: `storagePath` is empty');
            return false;
        }

        if (!this.get('retailLogPath') && !this.get('classicLogPath')) {
            console.warn('[ConfigService] Validation failed: `retailLogPath` and `classicLogPath` are empty. One needs to be set.');
            return false;
        }

        return true;
    }

    has(key: keyof ConfigurationSchema): boolean {
        return this._store.has(key);
    }

    get<T>(key: keyof ConfigurationSchema): T {
        if (!schema[key]) {
            throw Error(`[ConfigService] Attempted to get invalid configuration key '${key}'`)
        }

        const value = this._store.get(key);

        if (!this._store.has(key) || (value === '' || value === null || value === undefined)) {
            if (schema[key] && schema[key].default) {
                return (schema[key].default as T);
           }
        }

        return (value as T)
    }

    set(key: keyof ConfigurationSchema, value: any): void {
        if (!schema[key]) {
            throw Error(`[ConfigService] Attempted to set invalid configuration key '${key}'`)
        }

        if (value === null || value === undefined || value === '') {
            this._store.delete(key);
        } else {
            this._store.set(key, value);
        }
    }

    getPath(key: keyof ConfigurationSchema): string {
        return path.join(this.get(key), path.sep);
    }

    getNumber(key: keyof ConfigurationSchema): number {
        return this.has(key) ? parseInt(this.get(key)) : NaN;
    }

    getString(key: keyof ConfigurationSchema): string {
        return this.has(key) ? (this.get(key) as string) : '';
    }

    /**
     * Return a value for the `bufferPath` setting, based on the given `storagePath`.
     *
     * If `bufferPath` is not empty, it will simply be returned.
     * If `bufferPath` is empty, and `storagePath` is empty, so will `bufferPath` be.
     * If `bufferPath` is empty, and `storagePath` is not empty, we'll construct
     * a default value.
     */
    private resolvebufferPath (storagePath?: string, bufferPath?: string): string {
        if (bufferPath) {
            return bufferPath;
        }

        // Do not use `path` here, as it uses Node JS `process` which isn't available in the render process.
        return storagePath ? path.join(storagePath, '.temp') : '';
    }

    private updateDefaults(key: string, newValue: any): void {
        if (key === 'storagePath') {
            schema['bufferPath'].default = this.resolvebufferPath(
                newValue as string,
                this.get('bufferPath')
            );
            return;
        }
    }
};
