/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isNonEmptyArray } from 'vs/base/common/arrays';
import { IdleValue, sequence } from 'vs/base/common/async';
import { CancellationTokenSource, CancellationToken } from 'vs/base/common/cancellation';
import * as strings from 'vs/base/common/strings';
import { ICodeEditor, IActiveCodeEditor } from 'vs/editor/browser/editorBrowser';
import { IBulkEditService } from 'vs/editor/browser/services/bulkEditService';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { trimTrailingWhitespace } from 'vs/editor/common/commands/trimTrailingWhitespaceCommand';
import { ICodeActionsOnSaveOptions } from 'vs/editor/common/config/editorOptions';
import { EditOperation } from 'vs/editor/common/core/editOperation';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import { IIdentifiedSingleEditOperation, ISingleEditOperation, ITextModel } from 'vs/editor/common/model';
import { CodeAction } from 'vs/editor/common/modes';
import { IEditorWorkerService } from 'vs/editor/common/services/editorWorkerService';
import { shouldSynchronizeModel } from 'vs/editor/common/services/modelService';
import { getCodeActions } from 'vs/editor/contrib/codeAction/codeAction';
import { applyCodeAction } from 'vs/editor/contrib/codeAction/codeActionCommands';
import { CodeActionKind } from 'vs/editor/contrib/codeAction/codeActionTrigger';
import { getDocumentFormattingEdits, FormatMode } from 'vs/editor/contrib/format/format';
import { FormattingEdit } from 'vs/editor/contrib/format/formattingEdit';
import { SnippetController2 } from 'vs/editor/contrib/snippet/snippetController2';
import { localize } from 'vs/nls';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { IProgressService2, ProgressLocation } from 'vs/platform/progress/common/progress';
import { extHostCustomer } from 'vs/workbench/api/electron-browser/extHostCustomers';
import { TextFileEditorModel } from 'vs/workbench/services/textfile/common/textFileEditorModel';
import { ISaveParticipant, ITextFileEditorModel, SaveReason } from 'vs/workbench/services/textfile/common/textfiles';
import { ExtHostContext, ExtHostDocumentSaveParticipantShape, IExtHostContext } from '../node/extHost.protocol';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

export interface ISaveParticipantParticipant extends ISaveParticipant {
	// progressMessage: string;
}

class TrimWhitespaceParticipant implements ISaveParticipantParticipant {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService
	) {
		// Nothing
	}

	async participate(model: ITextFileEditorModel, env: { reason: SaveReason }): Promise<void> {
		if (this.configurationService.getValue('files.trimTrailingWhitespace', { overrideIdentifier: model.textEditorModel.getLanguageIdentifier().language, resource: model.getResource() })) {
			this.doTrimTrailingWhitespace(model.textEditorModel, env.reason === SaveReason.AUTO);
		}
	}

	private doTrimTrailingWhitespace(model: ITextModel, isAutoSaved: boolean): void {
		let prevSelection: Selection[] = [];
		let cursors: Position[] = [];

		const editor = findEditor(model, this.codeEditorService);
		if (editor) {
			// Find `prevSelection` in any case do ensure a good undo stack when pushing the edit
			// Collect active cursors in `cursors` only if `isAutoSaved` to avoid having the cursors jump
			prevSelection = editor.getSelections();
			if (isAutoSaved) {
				cursors = prevSelection.map(s => s.getPosition());
				const snippetsRange = SnippetController2.get(editor).getSessionEnclosingRange();
				if (snippetsRange) {
					for (let lineNumber = snippetsRange.startLineNumber; lineNumber <= snippetsRange.endLineNumber; lineNumber++) {
						cursors.push(new Position(lineNumber, model.getLineMaxColumn(lineNumber)));
					}
				}
			}
		}

		const ops = trimTrailingWhitespace(model, cursors);
		if (!ops.length) {
			return; // Nothing to do
		}

		model.pushEditOperations(prevSelection, ops, (edits) => prevSelection);
	}
}

function findEditor(model: ITextModel, codeEditorService: ICodeEditorService): IActiveCodeEditor | null {
	let candidate: IActiveCodeEditor | null = null;

	if (model.isAttachedToEditor()) {
		for (const editor of codeEditorService.listCodeEditors()) {
			if (editor.hasModel() && editor.getModel() === model) {
				if (editor.hasTextFocus()) {
					return editor; // favour focused editor if there are multiple
				}

				candidate = editor;
			}
		}
	}

	return candidate;
}

export class FinalNewLineParticipant implements ISaveParticipantParticipant {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService
	) {
		// Nothing
	}

	async participate(model: ITextFileEditorModel, env: { reason: SaveReason }): Promise<void> {
		if (this.configurationService.getValue('files.insertFinalNewline', { overrideIdentifier: model.textEditorModel.getLanguageIdentifier().language, resource: model.getResource() })) {
			this.doInsertFinalNewLine(model.textEditorModel);
		}
	}

	private doInsertFinalNewLine(model: ITextModel): void {
		const lineCount = model.getLineCount();
		const lastLine = model.getLineContent(lineCount);
		const lastLineIsEmptyOrWhitespace = strings.lastNonWhitespaceIndex(lastLine) === -1;

		if (!lineCount || lastLineIsEmptyOrWhitespace) {
			return;
		}

		let prevSelection: Selection[] = [];
		const editor = findEditor(model, this.codeEditorService);
		if (editor) {
			prevSelection = editor.getSelections();
		}

		model.pushEditOperations(prevSelection, [EditOperation.insert(new Position(lineCount, model.getLineMaxColumn(lineCount)), model.getEOL())], edits => prevSelection);

		if (editor) {
			editor.setSelections(prevSelection);
		}
	}
}

export class TrimFinalNewLinesParticipant implements ISaveParticipantParticipant {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService
	) {
		// Nothing
	}

	async participate(model: ITextFileEditorModel, env: { reason: SaveReason }): Promise<void> {
		if (this.configurationService.getValue('files.trimFinalNewlines', { overrideIdentifier: model.textEditorModel.getLanguageIdentifier().language, resource: model.getResource() })) {
			this.doTrimFinalNewLines(model.textEditorModel, env.reason === SaveReason.AUTO);
		}
	}

	/**
	 * returns 0 if the entire file is empty or whitespace only
	 */
	private findLastLineWithContent(model: ITextModel): number {
		for (let lineNumber = model.getLineCount(); lineNumber >= 1; lineNumber--) {
			const lineContent = model.getLineContent(lineNumber);
			if (strings.lastNonWhitespaceIndex(lineContent) !== -1) {
				// this line has content
				return lineNumber;
			}
		}
		// no line has content
		return 0;
	}

	private doTrimFinalNewLines(model: ITextModel, isAutoSaved: boolean): void {
		const lineCount = model.getLineCount();

		// Do not insert new line if file does not end with new line
		if (lineCount === 1) {
			return;
		}

		let prevSelection: Selection[] = [];
		let cannotTouchLineNumber = 0;
		const editor = findEditor(model, this.codeEditorService);
		if (editor) {
			prevSelection = editor.getSelections();
			if (isAutoSaved) {
				for (let i = 0, len = prevSelection.length; i < len; i++) {
					const positionLineNumber = prevSelection[i].positionLineNumber;
					if (positionLineNumber > cannotTouchLineNumber) {
						cannotTouchLineNumber = positionLineNumber;
					}
				}
			}
		}

		const lastLineNumberWithContent = this.findLastLineWithContent(model);
		const deleteFromLineNumber = Math.max(lastLineNumberWithContent + 1, cannotTouchLineNumber + 1);
		const deletionRange = model.validateRange(new Range(deleteFromLineNumber, 1, lineCount, model.getLineMaxColumn(lineCount)));

		if (deletionRange.isEmpty()) {
			return;
		}

		model.pushEditOperations(prevSelection, [EditOperation.delete(deletionRange)], edits => prevSelection);

		if (editor) {
			editor.setSelections(prevSelection);
		}
	}
}

class FormatOnSaveParticipant implements ISaveParticipantParticipant {

	constructor(
		@ICodeEditorService private readonly _editorService: ICodeEditorService,
		@IEditorWorkerService private readonly _editorWorkerService: IEditorWorkerService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) {
		// Nothing
	}

	async participate(editorModel: ITextFileEditorModel, env: { reason: SaveReason }): Promise<void> {

		const model = editorModel.textEditorModel;
		if (env.reason === SaveReason.AUTO
			|| !this._configurationService.getValue('editor.formatOnSave', { overrideIdentifier: model.getLanguageIdentifier().language, resource: editorModel.getResource() })) {
			return undefined;
		}

		const versionNow = model.getVersionId();
		const { tabSize, insertSpaces } = model.getOptions();

		const timeout = this._configurationService.getValue<number>('editor.formatOnSaveTimeout', { overrideIdentifier: model.getLanguageIdentifier().language, resource: editorModel.getResource() });

		return new Promise<ISingleEditOperation[] | null | undefined>((resolve, reject) => {
			let source = new CancellationTokenSource();
			let request = getDocumentFormattingEdits(this._telemetryService, this._editorWorkerService, model, { tabSize, insertSpaces }, FormatMode.Auto, source.token);

			setTimeout(() => {
				reject(localize('timeout.formatOnSave', "Aborted format on save after {0}ms", timeout));
				source.cancel();
			}, timeout);

			request.then(resolve, reject);

		}).then(edits => {
			if (isNonEmptyArray(edits) && versionNow === model.getVersionId()) {
				const editor = findEditor(model, this._editorService);
				if (editor) {
					this._editsWithEditor(editor, edits);
				} else {
					this._editWithModel(model, edits);
				}
			}
		});
	}

	private _editsWithEditor(editor: ICodeEditor, edits: ISingleEditOperation[]): void {
		FormattingEdit.execute(editor, edits);
	}

	private _editWithModel(model: ITextModel, edits: ISingleEditOperation[]): void {

		const [{ range }] = edits;
		const initialSelection = new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);

		model.pushEditOperations([initialSelection], edits.map(FormatOnSaveParticipant._asIdentEdit), undoEdits => {
			for (const { range } of undoEdits) {
				if (Range.areIntersectingOrTouching(range, initialSelection)) {
					return [new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn)];
				}
			}
			return null;
		});
	}

	private static _asIdentEdit({ text, range }: ISingleEditOperation): IIdentifiedSingleEditOperation {
		return {
			text,
			range: Range.lift(range),
			forceMoveMarkers: true
		};
	}
}

class CodeActionOnSaveParticipant implements ISaveParticipant {

	constructor(
		@IBulkEditService private readonly _bulkEditService: IBulkEditService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) { }

	async participate(editorModel: ITextFileEditorModel, env: { reason: SaveReason }): Promise<void> {
		if (env.reason === SaveReason.AUTO) {
			return undefined;
		}

		const model = editorModel.textEditorModel;

		const settingsOverrides = { overrideIdentifier: model.getLanguageIdentifier().language, resource: editorModel.getResource() };
		const setting = this._configurationService.getValue<ICodeActionsOnSaveOptions>('editor.codeActionsOnSave', settingsOverrides);
		if (!setting) {
			return undefined;
		}

		const codeActionsOnSave = Object.keys(setting)
			.filter(x => setting[x]).map(x => new CodeActionKind(x))
			.sort((a, b) => {
				if (a.value === CodeActionKind.SourceFixAll.value) {
					return -1;
				}
				if (b.value === CodeActionKind.SourceFixAll.value) {
					return 1;
				}
				return 0;
			});
		if (!codeActionsOnSave.length) {
			return undefined;
		}

		const tokenSource = new CancellationTokenSource();

		const timeout = this._configurationService.getValue<number>('editor.codeActionsOnSaveTimeout', settingsOverrides);

		return Promise.race([
			new Promise<void>((_resolve, reject) =>
				setTimeout(() => {
					tokenSource.cancel();
					reject(localize('codeActionsOnSave.didTimeout', "Aborted codeActionsOnSave after {0}ms", timeout));
				}, timeout)),
			this.applyOnSaveActions(model, codeActionsOnSave, tokenSource.token)
		]).then(() => {
			tokenSource.cancel();
		}, (e) => {
			tokenSource.cancel();
			return Promise.reject(e);
		});
	}

	private async applyOnSaveActions(model: ITextModel, codeActionsOnSave: CodeActionKind[], token: CancellationToken): Promise<void> {
		for (const codeActionKind of codeActionsOnSave) {
			const actionsToRun = await this.getActionsToRun(model, codeActionKind, token);
			try {
				await this.applyCodeActions(actionsToRun);
			} catch {
				// Failure to apply a code action should not block other on save actions
			}
		}
	}

	private async applyCodeActions(actionsToRun: CodeAction[]) {
		for (const action of actionsToRun) {
			await applyCodeAction(action, this._bulkEditService, this._commandService);
		}
	}

	private getActionsToRun(model: ITextModel, codeActionKind: CodeActionKind, token: CancellationToken) {
		return getCodeActions(model, model.getFullModelRange(), {
			type: 'auto',
			filter: { kind: codeActionKind, includeSourceActions: true },
		}, token);
	}
}

class ExtHostSaveParticipant implements ISaveParticipantParticipant {

	private _proxy: ExtHostDocumentSaveParticipantShape;

	constructor(extHostContext: IExtHostContext) {
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostDocumentSaveParticipant);
	}

	async participate(editorModel: ITextFileEditorModel, env: { reason: SaveReason }): Promise<void> {

		if (!shouldSynchronizeModel(editorModel.textEditorModel)) {
			// the model never made it to the extension
			// host meaning we cannot participate in its save
			return undefined;
		}

		return new Promise<any>((resolve, reject) => {
			setTimeout(() => reject(localize('timeout.onWillSave', "Aborted onWillSaveTextDocument-event after 1750ms")), 1750);
			this._proxy.$participateInSave(editorModel.getResource(), env.reason).then(values => {
				for (const success of values) {
					if (!success) {
						return Promise.reject(new Error('listener failed'));
					}
				}
				return undefined;
			}).then(resolve, reject);
		});
	}
}

// The save participant can change a model before its saved to support various scenarios like trimming trailing whitespace
@extHostCustomer
export class SaveParticipant implements ISaveParticipant {

	private readonly _saveParticipants: IdleValue<ISaveParticipantParticipant[]>;

	constructor(
		extHostContext: IExtHostContext,
		@IInstantiationService instantiationService: IInstantiationService,
		@IProgressService2 private readonly _progressService: IProgressService2,
		@ILogService private readonly _logService: ILogService
	) {
		this._saveParticipants = new IdleValue(() => [
			instantiationService.createInstance(TrimWhitespaceParticipant),
			instantiationService.createInstance(CodeActionOnSaveParticipant),
			instantiationService.createInstance(FormatOnSaveParticipant),
			instantiationService.createInstance(FinalNewLineParticipant),
			instantiationService.createInstance(TrimFinalNewLinesParticipant),
			instantiationService.createInstance(ExtHostSaveParticipant, extHostContext),
		]);
		// Hook into model
		TextFileEditorModel.setSaveParticipant(this);
	}

	dispose(): void {
		TextFileEditorModel.setSaveParticipant(null);
		this._saveParticipants.dispose();
	}

	async participate(model: ITextFileEditorModel, env: { reason: SaveReason }): Promise<void> {
		return this._progressService.withProgress({ location: ProgressLocation.Window }, progress => {
			progress.report({ message: localize('saveParticipants', "Running Save Participants...") });
			const promiseFactory = this._saveParticipants.getValue().map(p => () => {
				return p.participate(model, env);
			});
			return sequence(promiseFactory).then(() => { }, err => this._logService.warn(err));
		});
	}
}
