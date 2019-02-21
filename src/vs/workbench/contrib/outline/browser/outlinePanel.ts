/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { ProgressBar } from 'vs/base/browser/ui/progressbar/progressbar';
import { Action, IAction, RadioGroup } from 'vs/base/common/actions';
import { firstIndex } from 'vs/base/common/arrays';
import { createCancelablePromise, TimeoutTimer } from 'vs/base/common/async';
import { isPromiseCanceledError } from 'vs/base/common/errors';
import { Emitter } from 'vs/base/common/event';
import { defaultGenerator } from 'vs/base/common/idGenerator';
import { dispose, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { LRUCache } from 'vs/base/common/map';
import { escape } from 'vs/base/common/strings';
import { URI } from 'vs/base/common/uri';
import 'vs/css!./outlinePanel';
import { ICodeEditor, isCodeEditor, isDiffEditor } from 'vs/editor/browser/editorBrowser';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import { ITextModel } from 'vs/editor/common/model';
import { IModelContentChangedEvent } from 'vs/editor/common/model/textModelEvents';
import { DocumentSymbolProviderRegistry } from 'vs/editor/common/modes';
import { LanguageFeatureRegistry } from 'vs/editor/common/modes/languageFeatureRegistry';
import { OutlineElement, OutlineModel, TreeElement } from 'vs/editor/contrib/documentSymbols/outlineModel';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IResourceInput } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { WorkbenchDataTree } from 'vs/platform/list/browser/listService';
import { IMarkerService, MarkerSeverity } from 'vs/platform/markers/common/markers';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { attachProgressBarStyler } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { ViewletPanel } from 'vs/workbench/browser/parts/views/panelViewlet';
import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { CollapseAction2 } from 'vs/workbench/browser/viewlet';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from 'vs/workbench/services/editor/common/editorService';
import { OutlineConfigKeys, OutlineViewFocused, OutlineViewFiltered } from 'vs/editor/contrib/documentSymbols/outline';
import { FuzzyScore } from 'vs/base/common/filters';
import { OutlineDataSource, OutlineItemComparator, OutlineSortOrder, OutlineVirtualDelegate, OutlineGroupRenderer, OutlineElementRenderer, OutlineItem, OutlineIdentityProvider, OutlineNavigationLabelProvider } from 'vs/editor/contrib/documentSymbols/outlineTree';
import { IDataTreeViewState } from 'vs/base/browser/ui/tree/dataTree';
import { StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { basename } from 'vs/base/common/resources';

class RequestState {

	constructor(
		private _editorId: string,
		private _modelId: string,
		private _modelVersion: number,
		private _providerCount: number
	) {
		//
	}

	equals(other: RequestState): boolean {
		return other
			&& this._editorId === other._editorId
			&& this._modelId === other._modelId
			&& this._modelVersion === other._modelVersion
			&& this._providerCount === other._providerCount;
	}
}

class RequestOracle {

	private _disposables = new Array<IDisposable>();
	private _sessionDisposable: IDisposable;
	private _lastState?: RequestState;

	constructor(
		private readonly _callback: (editor: ICodeEditor | undefined, change: IModelContentChangedEvent | undefined) => any,
		private readonly _featureRegistry: LanguageFeatureRegistry<any>,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		_editorService.onDidActiveEditorChange(this._update, this, this._disposables);
		_featureRegistry.onDidChange(this._update, this, this._disposables);
		this._update();
	}

	dispose(): void {
		dispose(this._disposables);
		dispose(this._sessionDisposable);
	}

	private _update(): void {

		let widget = this._editorService.activeTextEditorWidget;
		let codeEditor: ICodeEditor | undefined = undefined;
		if (isCodeEditor(widget)) {
			codeEditor = widget;
		} else if (isDiffEditor(widget)) {
			codeEditor = widget.getModifiedEditor();
		}

		if (!codeEditor || !codeEditor.hasModel()) {
			this._lastState = undefined;
			this._callback(undefined, undefined);
			return;
		}

		let thisState = new RequestState(
			codeEditor.getId(),
			codeEditor.getModel().id,
			codeEditor.getModel().getVersionId(),
			this._featureRegistry.all(codeEditor.getModel()).length
		);

		if (this._lastState && thisState.equals(this._lastState)) {
			// prevent unneccesary changes...
			return;
		}
		dispose(this._sessionDisposable);
		this._lastState = thisState;
		this._callback(codeEditor, undefined);

		let handle: any;
		let contentListener = codeEditor.onDidChangeModelContent(event => {
			clearTimeout(handle);
			handle = setTimeout(() => this._callback(codeEditor!, event), 350);
		});
		let modeListener = codeEditor.onDidChangeModelLanguage(_ => {
			this._callback(codeEditor!, undefined);
		});
		let disposeListener = codeEditor.onDidDispose(() => {
			this._callback(undefined, undefined);
		});
		this._sessionDisposable = {
			dispose() {
				contentListener.dispose();
				clearTimeout(handle);
				modeListener.dispose();
				disposeListener.dispose();
			}
		};
	}
}

class SimpleToggleAction extends Action {

	constructor(label: string, checked: boolean, callback: (action: SimpleToggleAction) => any, className?: string) {
		super(`simple` + defaultGenerator.nextId(), label, className, true, () => {
			this.checked = !this.checked;
			callback(this);
			return Promise.resolve();
		});
		this.checked = checked;
	}
}


class OutlineViewState {

	private _followCursor = false;
	private _filterOnType = true;
	private _sortBy = OutlineSortOrder.ByKind;

	private _onDidChange = new Emitter<{ followCursor?: boolean, sortBy?: boolean, filterOnType?: boolean }>();
	readonly onDidChange = this._onDidChange.event;

	set followCursor(value: boolean) {
		if (value !== this._followCursor) {
			this._followCursor = value;
			this._onDidChange.fire({ followCursor: true });
		}
	}

	get followCursor(): boolean {
		return this._followCursor;
	}

	get filterOnType() {
		return this._filterOnType;
	}

	set filterOnType(value) {
		if (value !== this._filterOnType) {
			this._filterOnType = value;
			this._onDidChange.fire({ filterOnType: true });
		}
	}

	set sortBy(value: OutlineSortOrder) {
		if (value !== this._sortBy) {
			this._sortBy = value;
			this._onDidChange.fire({ sortBy: true });
		}
	}

	get sortBy(): OutlineSortOrder {
		return this._sortBy;
	}

	persist(storageService: IStorageService): void {
		storageService.store('outline/state', JSON.stringify({ followCursor: this.followCursor, sortBy: this.sortBy }), StorageScope.WORKSPACE);
	}

	restore(storageService: IStorageService): void {
		let raw = storageService.get('outline/state', StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}
		let data: any;
		try {
			data = JSON.parse(raw);
		} catch (e) {
			return;
		}
		this.followCursor = data.followCursor;
		this.sortBy = data.sortBy;
	}
}

export class OutlinePanel extends ViewletPanel {

	private _disposables = new Array<IDisposable>();

	private _editorDisposables = new Array<IDisposable>();
	private _outlineViewState = new OutlineViewState();
	private _requestOracle?: RequestOracle;
	private _cachedHeight: number;
	private _domNode: HTMLElement;
	private _message: HTMLDivElement;
	private _inputContainer: HTMLDivElement;
	private _progressBar: ProgressBar;
	private _tree: WorkbenchDataTree<OutlineModel, OutlineItem, FuzzyScore>;
	private _treeDataSource: OutlineDataSource;
	private _treeRenderer: OutlineElementRenderer;
	private _treeComparator: OutlineItemComparator;
	private _treeStates = new LRUCache<string, IDataTreeViewState>(10);

	private _treeFakeUIEvent = new UIEvent('me');

	private readonly _contextKeyFocused: IContextKey<boolean>;
	private readonly _contextKeyFiltered: IContextKey<boolean>;

	constructor(
		options: IViewletViewOptions,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IThemeService private readonly _themeService: IThemeService,
		@IStorageService private readonly _storageService: IStorageService,
		@IEditorService private readonly _editorService: IEditorService,
		@IMarkerService private readonly _markerService: IMarkerService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService contextMenuService: IContextMenuService,
	) {
		super(options, keybindingService, contextMenuService, configurationService);
		this._outlineViewState.restore(this._storageService);
		this._contextKeyFocused = OutlineViewFocused.bindTo(contextKeyService);
		this._contextKeyFiltered = OutlineViewFiltered.bindTo(contextKeyService);
		this._disposables.push(this.onDidFocus(_ => this._contextKeyFocused.set(true)));
		this._disposables.push(this.onDidBlur(_ => this._contextKeyFocused.set(false)));
	}

	dispose(): void {
		dispose(this._disposables);
		dispose(this._requestOracle);
		dispose(this._editorDisposables);
		super.dispose();
	}

	focus(): void {
		if (this._tree) {
			// focus on tree and fallback to root
			// dom node when the tree cannot take focus,
			// e.g. when hidden
			this._tree.domFocus();
			if (!this._tree.isDOMFocused()) {
				this._domNode.focus();
			}
		}
	}

	protected renderBody(container: HTMLElement): void {
		this._domNode = container;
		this._domNode.tabIndex = 0;
		dom.addClass(container, 'outline-panel');

		let progressContainer = dom.$('.outline-progress');
		this._message = dom.$('.outline-message');
		this._inputContainer = dom.$('.outline-input');

		this._progressBar = new ProgressBar(progressContainer);
		this.disposables.push(attachProgressBarStyler(this._progressBar, this._themeService));

		let treeContainer = dom.$('.outline-tree');
		dom.append(
			container,
			progressContainer, this._message, this._inputContainer, treeContainer
		);

		this._treeRenderer = this._instantiationService.createInstance(OutlineElementRenderer);
		this._treeDataSource = new OutlineDataSource();
		this._treeComparator = new OutlineItemComparator(this._outlineViewState.sortBy);
		this._tree = this._instantiationService.createInstance(
			WorkbenchDataTree,
			treeContainer,
			new OutlineVirtualDelegate(),
			[new OutlineGroupRenderer(), this._treeRenderer],
			this._treeDataSource,
			{
				expandOnlyOnTwistieClick: true,
				multipleSelectionSupport: false,
				filterOnType: this._outlineViewState.filterOnType,
				sorter: this._treeComparator,
				identityProvider: new OutlineIdentityProvider(),
				keyboardNavigationLabelProvider: this._instantiationService.createInstance(OutlineNavigationLabelProvider)
			}
		) as WorkbenchDataTree<OutlineModel, OutlineItem, FuzzyScore>;

		this._disposables.push(this._tree);
		this._disposables.push(this._outlineViewState.onDidChange(this._onDidChangeUserState, this));

		// todo@joh workaournd for the tree resetting the filter behaviour
		// to something globally defined
		this._tree.updateOptions({
			filterOnType: this._outlineViewState.filterOnType
		});

		// feature: toggle icons
		this.disposables.push(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(OutlineConfigKeys.icons)) {
				this._tree.updateChildren();
			}
		}));

		this.disposables.push(this.onDidChangeBodyVisibility(visible => {
			if (visible && !this._requestOracle) {
				this._requestOracle = this._instantiationService.createInstance(RequestOracle, (editor, event) => this._doUpdate(editor, event), DocumentSymbolProviderRegistry);
			} else if (!visible) {
				dispose(this._requestOracle);
				this._requestOracle = undefined;
				this._doUpdate(undefined, undefined);
			}
		}));
	}

	protected layoutBody(height: number): void {
		if (height !== this._cachedHeight) {
			this._tree.layout(height);
		}
	}

	getActions(): IAction[] {
		return [
			new Action('collapse', localize('collapse', "Collapse All"), 'explorer-action collapse-explorer', true, () => {
				return new CollapseAction2(this._tree, true, undefined).run();
			})
		];
	}

	getSecondaryActions(): IAction[] {
		let group = new RadioGroup([
			new SimpleToggleAction(localize('sortByPosition', "Sort By: Position"), this._outlineViewState.sortBy === OutlineSortOrder.ByPosition, _ => this._outlineViewState.sortBy = OutlineSortOrder.ByPosition),
			new SimpleToggleAction(localize('sortByName', "Sort By: Name"), this._outlineViewState.sortBy === OutlineSortOrder.ByName, _ => this._outlineViewState.sortBy = OutlineSortOrder.ByName),
			new SimpleToggleAction(localize('sortByKind', "Sort By: Type"), this._outlineViewState.sortBy === OutlineSortOrder.ByKind, _ => this._outlineViewState.sortBy = OutlineSortOrder.ByKind),
		]);
		let result = [
			new SimpleToggleAction(localize('followCur', "Follow Cursor"), this._outlineViewState.followCursor, action => this._outlineViewState.followCursor = action.checked),
			new SimpleToggleAction(localize('filterOnType', "Filter on Type"), this._outlineViewState.filterOnType, action => this._outlineViewState.filterOnType = action.checked),
			new Separator(),
			...group.actions,
		];

		this.disposables.push(...result);
		this.disposables.push(group);
		return result;
	}

	private _onDidChangeUserState(e: { followCursor?: boolean, sortBy?: boolean, filterOnType?: boolean }) {
		this._outlineViewState.persist(this._storageService);
		if (e.followCursor) {
			// todo@joh update immediately
		}
		if (e.sortBy) {
			this._treeComparator.type = this._outlineViewState.sortBy;
			this._tree.resort();
		}
		if (e.filterOnType) {
			this._tree.updateOptions({
				filterOnType: this._outlineViewState.filterOnType
			});
		}
	}

	private _showMessage(message: string) {
		dom.addClass(this._domNode, 'message');
		this._tree.setInput(undefined);
		this._progressBar.stop().hide();
		this._message.innerText = escape(message);
	}

	private static _createOutlineModel(model: ITextModel, disposables: IDisposable[]): Promise<OutlineModel | undefined> {
		let promise = createCancelablePromise(token => OutlineModel.create(model, token));
		disposables.push({ dispose() { promise.cancel(); } });
		return promise.catch(err => {
			if (!isPromiseCanceledError(err)) {
				throw err;
			}
			return undefined;
		});
	}

	private async _doUpdate(editor: ICodeEditor | undefined, event: IModelContentChangedEvent | undefined): Promise<void> {
		dispose(this._editorDisposables);

		this._editorDisposables = new Array();
		this._progressBar.infinite().show(150);

		let oldModel = this._tree.getInput();

		// persist state
		if (oldModel) {
			let state = this._tree.getViewState();
			this._treeStates.set(oldModel.textModel.uri.toString(), state);
		}

		if (!editor || !editor.hasModel() || !DocumentSymbolProviderRegistry.has(editor.getModel())) {
			return this._showMessage(localize('no-editor', "There are no editors open that can provide outline information."));
		}

		let textModel = editor.getModel();
		let loadingMessage: IDisposable | undefined;
		if (!oldModel) {
			loadingMessage = new TimeoutTimer(
				() => this._showMessage(localize('loading', "Loading document symbols for '{0}'...", basename(textModel.uri))),
				100
			);
		}

		let createdModel = await OutlinePanel._createOutlineModel(textModel, this._editorDisposables);
		dispose(loadingMessage);
		if (!createdModel) {
			return;
		}

		let newModel = createdModel;
		if (TreeElement.empty(newModel)) {
			return this._showMessage(localize('no-symbols', "No symbols found in document '{0}'", basename(textModel.uri)));
		}

		dom.removeClass(this._domNode, 'message');

		if (event && oldModel && textModel.getLineCount() >= 25) {
			// heuristic: when the symbols-to-lines ratio changes by 50% between edits
			// wait a little (and hope that the next change isn't as drastic).
			let newSize = TreeElement.size(newModel);
			let newLength = textModel.getValueLength();
			let newRatio = newSize / newLength;
			let oldSize = TreeElement.size(oldModel);
			let oldLength = newLength - event.changes.reduce((prev, value) => prev + value.rangeLength, 0);
			let oldRatio = oldSize / oldLength;
			if (newRatio <= oldRatio * 0.5 || newRatio >= oldRatio * 1.5) {

				let waitPromise = new Promise<boolean>(resolve => {
					let handle: any = setTimeout(() => {
						handle = undefined;
						resolve(true);
					}, 2000);
					this._disposables.push({
						dispose() {
							clearTimeout(handle);
							resolve(false);
						}
					});
				});

				if (!await waitPromise) {
					return;
				}
			}
		}

		this._progressBar.stop().hide();

		if (oldModel && oldModel.merge(newModel)) {
			this._tree.updateChildren();
			newModel = oldModel;
		} else {
			let state = this._treeStates.get(newModel.textModel.uri.toString());
			await this._tree.setInput(newModel, state);
		}

		this.layoutBody(this._cachedHeight);

		// transfer focus from domNode to the tree
		if (this._domNode === document.activeElement) {
			this._tree.domFocus();
		}

		this._editorDisposables.push(toDisposable(() => this._contextKeyFiltered.reset()));

		// feature: reveal outline selection in editor
		// on change -> reveal/select defining range
		this._editorDisposables.push(this._tree.onDidChangeSelection(e => {
			if (e.browserEvent === this._treeFakeUIEvent /* || e.payload && e.payload.didClickOnTwistie */) {
				return;
			}
			let [first] = e.elements;
			if (!(first instanceof OutlineElement)) {
				return;
			}

			let focus = false;
			let aside = false;
			// todo@Joh
			if (e.browserEvent) {
				if (e.browserEvent.type === 'keydown') {
					focus = true;
				} else if (e.browserEvent.type === 'click') {
					const event = new StandardMouseEvent(e.browserEvent as MouseEvent);
					focus = e.browserEvent.detail === 2;
					aside = (!this._tree.useAltAsMultipleSelectionModifier && event.altKey)
						|| (this._tree.useAltAsMultipleSelectionModifier && (event.ctrlKey || event.metaKey));
				}
			}
			this._revealTreeSelection(newModel, first, focus, aside);
		}));

		// feature: reveal editor selection in outline
		this._revealEditorSelection(newModel, editor.getSelection());
		const versionIdThen = newModel.textModel.getVersionId();
		this._editorDisposables.push(editor.onDidChangeCursorSelection(e => {
			// first check if the document has changed and stop revealing the
			// cursor position iff it has -> we will update/recompute the
			// outline view then anyways
			if (!newModel.textModel.isDisposed() && newModel.textModel.getVersionId() === versionIdThen) {
				this._revealEditorSelection(newModel, e.selection);
			}
		}));

		// feature: show markers in outline
		const updateMarker = (e: URI[], ignoreEmpty?: boolean) => {
			if (!this._configurationService.getValue(OutlineConfigKeys.problemsEnabled)) {
				return;
			}
			if (firstIndex(e, a => a.toString() === textModel.uri.toString()) < 0) {
				return;
			}
			const marker = this._markerService.read({ resource: textModel.uri, severities: MarkerSeverity.Error | MarkerSeverity.Warning });
			if (marker.length > 0 || !ignoreEmpty) {
				newModel.updateMarker(marker);
				this._tree.updateChildren();
			}
		};
		updateMarker([textModel.uri], true);
		this._editorDisposables.push(this._markerService.onMarkerChanged(updateMarker));

		this._editorDisposables.push(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(OutlineConfigKeys.problemsBadges) || e.affectsConfiguration(OutlineConfigKeys.problemsColors)) {
				this._tree.updateChildren();
				return;
			}
			if (!e.affectsConfiguration(OutlineConfigKeys.problemsEnabled)) {
				return;
			}
			if (!this._configurationService.getValue(OutlineConfigKeys.problemsEnabled)) {
				newModel.updateMarker([]);
				this._tree.updateChildren();
			} else {
				updateMarker([textModel.uri], true);
			}
		}));
	}

	private async _revealTreeSelection(model: OutlineModel, element: OutlineElement, focus: boolean, aside: boolean): Promise<void> {

		await this._editorService.openEditor({
			resource: model.textModel.uri,
			options: {
				preserveFocus: !focus,
				selection: Range.collapseToStart(element.symbol.selectionRange),
				revealInCenterIfOutsideViewport: true
			}
		} as IResourceInput, aside ? SIDE_GROUP : ACTIVE_GROUP);
	}

	private async _revealEditorSelection(model: OutlineModel, selection: Selection): Promise<void> {
		if (!this._outlineViewState.followCursor || !this._tree.getInput() || !selection) {
			return;
		}
		let [first] = this._tree.getSelection();
		let item = model.getItemEnclosingPosition({
			lineNumber: selection.selectionStartLineNumber,
			column: selection.selectionStartColumn
		}, first instanceof OutlineElement ? first : undefined);
		if (!item) {
			// nothing to reveal
			return;
		}
		let top = this._tree.getRelativeTop(item);
		if (typeof top === 'number' && (top < 0 || top > 1)) {
			// only when outside view port
			await this._tree.reveal(item, 0.5);
		}
		this._tree.setFocus([item], this._treeFakeUIEvent);
		this._tree.setSelection([item], this._treeFakeUIEvent);
	}
}
