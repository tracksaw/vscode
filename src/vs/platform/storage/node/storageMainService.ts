/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { Event, Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { ILogService, LogLevel } from 'vs/platform/log/common/log';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IStorage, Storage, SQLiteStorageDatabase, ISQLiteStorageDatabaseLoggingOptions, InMemoryStorageDatabase } from 'vs/base/node/storage';
import { join } from 'vs/base/common/path';
import { exists, readdir } from 'vs/base/node/pfs';
import { Database } from 'vscode-sqlite3';
import { endsWith, startsWith } from 'vs/base/common/strings';

export const IStorageMainService = createDecorator<IStorageMainService>('storageMainService');

export interface IStorageMainService {

	_serviceBrand: any;

	/**
	 * Emitted whenever data is updated or deleted.
	 */
	readonly onDidChangeStorage: Event<IStorageChangeEvent>;

	/**
	 * Emitted when the storage is about to persist. This is the right time
	 * to persist data to ensure it is stored before the application shuts
	 * down.
	 */
	readonly onWillSaveState: Event<void>;

	/**
	 * Retrieve an element stored with the given key from storage. Use
	 * the provided defaultValue if the element is null or undefined.
	 */
	get(key: string, fallbackValue: string): string;
	get(key: string, fallbackValue?: string): string | undefined;

	/**
	 * Retrieve an element stored with the given key from storage. Use
	 * the provided defaultValue if the element is null or undefined. The element
	 * will be converted to a boolean.
	 */
	getBoolean(key: string, fallbackValue: boolean): boolean;
	getBoolean(key: string, fallbackValue?: boolean): boolean | undefined;

	/**
	 * Retrieve an element stored with the given key from storage. Use
	 * the provided defaultValue if the element is null or undefined. The element
	 * will be converted to a number using parseInt with a base of 10.
	 */
	getInteger(key: string, fallbackValue: number): number;
	getInteger(key: string, fallbackValue?: number): number | undefined;

	/**
	 * Store a string value under the given key to storage. The value will
	 * be converted to a string.
	 */
	store(key: string, value: any): void;

	/**
	 * Delete an element stored under the provided key from storage.
	 */
	remove(key: string): void;
}

export interface IStorageChangeEvent {
	key: string;
}

export class StorageMainService extends Disposable implements IStorageMainService {

	_serviceBrand: any;

	private static STORAGE_NAME = 'state.vscdb';

	private readonly _onDidChangeStorage: Emitter<IStorageChangeEvent> = this._register(new Emitter<IStorageChangeEvent>());
	get onDidChangeStorage(): Event<IStorageChangeEvent> { return this._onDidChangeStorage.event; }

	private readonly _onWillSaveState: Emitter<void> = this._register(new Emitter<void>());
	get onWillSaveState(): Event<void> { return this._onWillSaveState.event; }

	get items(): Map<string, string> { return this.storage.items; }

	private storage: IStorage;

	private initializePromise: Promise<void>;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService
	) {
		super();

		// Until the storage has been initialized, it can only be in memory
		this.storage = new Storage(new InMemoryStorageDatabase());
	}

	private get storagePath(): string {
		if (!!this.environmentService.extensionTestsPath) {
			return SQLiteStorageDatabase.IN_MEMORY_PATH; // no storage during extension tests!
		}

		return join(this.environmentService.globalStorageHome, StorageMainService.STORAGE_NAME);
	}

	private createLogginOptions(): ISQLiteStorageDatabaseLoggingOptions {
		return {
			logTrace: (this.logService.getLevel() === LogLevel.Trace) ? msg => this.logService.trace(msg) : undefined,
			logError: error => this.logService.error(error)
		} as ISQLiteStorageDatabaseLoggingOptions;
	}

	initialize(): Promise<void> {
		if (!this.initializePromise) {
			this.initializePromise = this.doInitialize();
		}

		return this.initializePromise;
	}

	private doInitialize(): Promise<void> {
		const useInMemoryStorage = this.storagePath === SQLiteStorageDatabase.IN_MEMORY_PATH;

		let globalStorageExists: Promise<boolean>;
		if (useInMemoryStorage) {
			globalStorageExists = Promise.resolve(true);
		} else {
			globalStorageExists = exists(this.storagePath);
		}

		return globalStorageExists.then(exists => {
			this.storage.dispose();
			this.storage = new Storage(new SQLiteStorageDatabase(this.storagePath, {
				logging: this.createLogginOptions()
			}));

			this._register(this.storage.onDidChangeStorage(key => this._onDidChangeStorage.fire({ key })));

			return this.storage.init().then(() => {

				// Migrate storage if this is the first start and we are not using in-memory
				let migrationPromise: Promise<void>;
				if (!useInMemoryStorage && !exists) {
					// TODO@Ben remove global storage migration and move Storage creation back to ctor
					migrationPromise = this.migrateGlobalStorage().then(() => this.logService.info('[storage] migrated global storage'), error => this.logService.error(`[storage] migration error ${error}`));
				} else {
					migrationPromise = Promise.resolve();
				}

				return migrationPromise;
			});
		});
	}

	private migrateGlobalStorage(): Promise<void> {
		this.logService.info('[storage] migrating global storage from localStorage into SQLite');

		const localStorageDBBackup = join(this.environmentService.userDataPath, 'Local Storage', 'file__0.vscmig');

		return exists(localStorageDBBackup).then(exists => {
			if (!exists) {
				return Promise.resolve(); // return if there is no DB to migrate from
			}

			return readdir(this.environmentService.extensionsPath).then(extensions => {
				const supportedKeys = new Map<string, string>();
				[
					'editorFontInfo',
					'peekViewLayout',
					'expandSuggestionDocs',
					'extensionsIdentifiers/disabled',
					'integrityService',
					'telemetry.lastSessionDate',
					'telemetry.instanceId',
					'telemetry.firstSessionDate',
					'workbench.sidebar.width',
					'workbench.panel.width',
					'workbench.panel.height',
					'workbench.panel.sizeBeforeMaximized',
					'workbench.activity.placeholderViewlets',
					'colorThemeData',
					'iconThemeData',
					'workbench.telemetryOptOutShown',
					'workbench.hide.welcome',
					'releaseNotes/lastVersion',
					'debug.actionswidgetposition',
					'debug.actionswidgety',
					'editor.neverPromptForLargeFiles',
					'menubar/electronFixRecommended',
					'learnMoreDirtyWriteError',
					'extensions.ignoredAutoUpdateExtension',
					'askToInstallRemoteServerExtension',
					'hasNotifiedOfSettingsAutosave',
					'commandPalette.mru.cache',
					'commandPalette.mru.counter',
					'parts-splash-data',
					'terminal.integrated.neverMeasureRenderTime',
					'terminal.integrated.neverSuggestSelectWindowsShell',
					'memento/workbench.parts.editor',
					'memento/workbench.view.search',
					'langugage.update.donotask',
					'extensionsAssistant/languagePackSuggestionIgnore',
					'workbench.panel.pinnedPanels',
					'workbench.activity.pinnedViewlets',
					'extensionsAssistant/ignored_recommendations',
					'extensionsAssistant/recommendations',
					'extensionsAssistant/importantRecommendationsIgnore',
					'extensionsAssistant/fileExtensionsSuggestionIgnore',
					'nps/skipVersion',
					'nps/lastSessionDate',
					'nps/sessionCount',
					'nps/isCandidate',
					'allExperiments',
					'currentOrPreviouslyRunExperiments',
					'update/win32-64bits',
					'update/win32-fast-updates',
					'update/lastKnownVersion',
					'update/updateNotificationTime'
				].forEach(key => supportedKeys.set(key.toLowerCase(), key));

				// https://github.com/Microsoft/vscode/issues/68468
				const wellKnownPublishers = ['Microsoft', 'GitHub'];
				const wellKnownExtensions = ['ms-vscode.Go', 'WallabyJs.quokka-vscode', 'Telerik.nativescript', 'Shan.code-settings-sync', 'ritwickdey.LiveServer', 'PKief.material-icon-theme', 'PeterJausovec.vscode-docker', 'ms-vscode.PowerShell', 'LaurentTreguier.vscode-simple-icons', 'KnisterPeter.vscode-github', 'DotJoshJohnson.xml', 'Dart-Code.dart-code', 'alefragnani.Bookmarks'];

				// Support extension storage as well (always the ID of the extension)
				extensions.forEach(extension => {
					let extensionId: string;
					if (extension.indexOf('-') >= 0) {
						extensionId = extension.substring(0, extension.lastIndexOf('-')); // convert "author.extension-0.2.5" => "author.extension"
					} else {
						extensionId = extension;
					}

					if (extensionId) {
						for (let i = 0; i < wellKnownPublishers.length; i++) {
							const publisher = wellKnownPublishers[i];
							if (startsWith(extensionId, `${publisher.toLowerCase()}.`)) {
								extensionId = `${publisher}${extensionId.substr(publisher.length)}`;
								break;
							}
						}

						for (let j = 0; j < wellKnownExtensions.length; j++) {
							const wellKnownExtension = wellKnownExtensions[j];
							if (extensionId === wellKnownExtension.toLowerCase()) {
								extensionId = wellKnownExtension;
								break;
							}
						}

						supportedKeys.set(extensionId.toLowerCase(), extensionId);
					}
				});

				return import('vscode-sqlite3').then(sqlite3 => {

					return new Promise<void>((resolve, reject) => {
						const handleSuffixKey = (row, key: string, suffix: string) => {
							if (endsWith(key, suffix.toLowerCase())) {
								const value: string = row.value.toString('utf16le');
								const normalizedKey = key.substring(0, key.length - suffix.length) + suffix;

								this.store(normalizedKey, value);

								return true;
							}

							return false;
						};

						const db: Database = new (sqlite3.Database)(localStorageDBBackup, error => {
							if (error) {
								if (db) {
									db.close();
								}

								return reject(error);
							}

							db.all('SELECT key, value FROM ItemTable', (error, rows) => {
								if (error) {
									db.close();

									return reject(error);
								}

								try {
									rows.forEach(row => {
										let key: string = row.key;
										if (key.indexOf('storage://global/') !== 0) {
											return; // not a global key
										}

										// convert storage://global/colorthemedata => colorthemedata
										key = key.substr('storage://global/'.length);

										const supportedKey = supportedKeys.get(key);
										if (supportedKey) {
											const value: string = row.value.toString('utf16le');

											this.store(supportedKey, value);
										}

										// dynamic values
										else if (
											endsWith(key, '.hidden') ||
											startsWith(key, 'experiments.')
										) {
											const value: string = row.value.toString('utf16le');

											this.store(key, value);
										}

										// fix lowercased ".sessionCount"
										else if (handleSuffixKey(row, key, '.sessionCount')) { }

										// fix lowercased ".lastSessionDate"
										else if (handleSuffixKey(row, key, '.lastSessionDate')) { }

										// fix lowercased ".skipVersion"
										else if (handleSuffixKey(row, key, '.skipVersion')) { }

										// fix lowercased ".isCandidate"
										else if (handleSuffixKey(row, key, '.isCandidate')) { }

										// fix lowercased ".editedCount"
										else if (handleSuffixKey(row, key, '.editedCount')) { }

										// fix lowercased ".editedDate"
										else if (handleSuffixKey(row, key, '.editedDate')) { }
									});

									db.close();
								} catch (error) {
									db.close();

									return reject(error);
								}

								resolve();
							});
						});
					});
				});
			});
		});
	}

	get(key: string, fallbackValue: string): string;
	get(key: string, fallbackValue?: string): string | undefined;
	get(key: string, fallbackValue?: string): string | undefined {
		return this.storage.get(key, fallbackValue);
	}

	getBoolean(key: string, fallbackValue: boolean): boolean;
	getBoolean(key: string, fallbackValue?: boolean): boolean | undefined;
	getBoolean(key: string, fallbackValue?: boolean): boolean | undefined {
		return this.storage.getBoolean(key, fallbackValue);
	}

	getInteger(key: string, fallbackValue: number): number;
	getInteger(key: string, fallbackValue?: number): number | undefined;
	getInteger(key: string, fallbackValue?: number): number | undefined {
		return this.storage.getInteger(key, fallbackValue);
	}

	store(key: string, value: any): Promise<void> {
		return this.storage.set(key, value);
	}

	remove(key: string): Promise<void> {
		return this.storage.delete(key);
	}

	close(): Promise<void> {

		// Signal as event so that clients can still store data
		this._onWillSaveState.fire();

		// Do it
		return this.storage.close();
	}

	checkIntegrity(full: boolean): Promise<string> {
		return this.storage.checkIntegrity(full);
	}
}
