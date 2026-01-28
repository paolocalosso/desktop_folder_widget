import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SCHEMA = 'org.gnome.shell.extensions.desktop-folder-widget';
const KEY_EDIT = 'edit-mode';
const KEY_VISIBLE = 'visible';
const KEY_COLLAPSED = 'collapsed';

export default class DesktopFolderWidgetExtension extends Extension {

  enable() {
    this._settings = this.getSettings(SCHEMA);
    this._menuOpen = false;

    // PARTENZA DA HOME invece di Desktop
    this._currentDir = Gio.File.new_for_path(GLib.get_home_dir());
    this._dirStack = [];

    // ---- Widget ----
    this._box = new St.BoxLayout({
      vertical: true,
      reactive: true,
      can_focus: true,
      track_hover: true,
    });
    this._box.set_style(`
      padding: 12px;
      border-radius: 12px;
      background-color: rgba(0,0,0,0.60);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
    `);

    // Titlebar con breadcrumb
    this._titleBar = new St.BoxLayout({
      vertical: false,
      style: 'margin-bottom: 6px;',
    });

    // Bottone "indietro"
    this._backBtn = new St.Button({
      reactive: true,
      can_focus: true,
      track_hover: true,
      visible: false,
      style: `
        padding: 3px;
        border-radius: 6px;
        background-color: rgba(255,255,255,0.10);
        margin-right: 4px;
      `,
    });
    const backIcon = new St.Icon({
      icon_name: 'go-previous-symbolic',
      style: 'icon-size: 14px; color: #83a598;',
    });
    this._backBtn.set_child(backIcon);
    this._backBtn.connect('clicked', () => this._navigateBack());

    this._titleLabel = new St.Label({
      text: 'Home',
      style: 'font-weight: bold;',
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._openBtn = new St.Button({
      reactive: true,
      can_focus: true,
      track_hover: true,
      style: `
        padding: 3px;
        border-radius: 6px;
        background-color: rgba(255,255,255,0.10);
      `,
    });
    this._openIcon = new St.Icon({
      icon_name: 'folder-open-symbolic',
      style: 'icon-size: 14px; color: #83a598;',
    });
    this._openBtn.set_child(this._openIcon);

    this._titleBar.add_child(this._backBtn);
    this._titleBar.add_child(this._titleLabel);
    this._titleBar.add_child(new St.Widget({x_expand: true}));
    this._titleBar.add_child(this._openBtn);

    // Campo ricerca
    this._searchEntry = new St.Entry({
      hint_text: 'Cerca...',
      can_focus: true,
      track_hover: true,
      style: `
        margin-bottom: 6px;
        padding: 4px 8px;
        border-radius: 6px;
        background-color: rgba(255,255,255,0.08);
        color: #fff;
      `,
    });

    this._searchEntry.clutter_text.connect('text-changed', () => {
      const text = this._searchEntry.get_text();
      this._settings.set_string('search-text', text);
      this._refresh();
    });

    // ESC cancella il testo di ricerca
    this._searchEntry.clutter_text.connect('key-press-event', (actor, event) => {
      const symbol = event.get_key_symbol();
      if (symbol === Clutter.KEY_Escape) {
        this._searchEntry.set_text('');
        global.stage.set_key_focus(null);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    // Resize handle
    this._resizeHandle = new St.Widget({
      reactive: true,
      can_focus: true,
      track_hover: true,
      width: 16,
      height: 16,
    });
    this._resizeHandle.set_style(`
      background-color: rgba(255,255,255,0.25);
      border-radius: 8px;
    `);

    this._bottomBar = new St.BoxLayout({vertical: false});
    this._bottomBar.add_child(new St.Widget({x_expand: true}));
    this._bottomBar.add_child(this._resizeHandle);

    // Contenitore scrollabile
    this._scrollView = new St.ScrollView({
      style_class: 'quick-files-scrollview',
      overlay_scrollbars: true,
    });
    this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    this._scrollView.set_style('max-height: 450px;');

    // La lista vera e propria
    this._list = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
    });

    this._scrollView.set_child(this._list);

    this._box.add_child(this._titleBar);
    this._box.add_child(this._searchEntry);
    this._box.add_child(this._scrollView);
    this._box.add_child(new St.Widget({y_expand: true}));
    this._box.add_child(this._bottomBar);

    // Stato expand/collapse
    this._expanded = true;
    this._collapsedHeight = 44;

    // Click sull'icona: toggle expand/collapse
    this._openBtnPressId = this._openBtn.connect('button-press-event', (actor, event) => {
      const button = event.get_button();
      if (button !== 1)
        return Clutter.EVENT_PROPAGATE;

      if (this._settings.get_boolean(KEY_COLLAPSED)) {
        if (this._expanded)
          this._collapseWidget();
        else
          this._expandWidget();
        return Clutter.EVENT_STOP;
      }

      // Non in collapsed mode: apri folder in Nautilus (se non in edit)
      if (!this._settings.get_boolean(KEY_EDIT)) {
        this._openUri(this._currentDir.get_uri());
        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    });

    // Listener per click sullo stage (solo desktop, non su finestre)
    this._stageClickId = global.stage.connect('button-press-event', (actor, event) => {
      if (!this._settings.get_boolean(KEY_COLLAPSED))
        return Clutter.EVENT_PROPAGATE;
      if (!this._expanded || !this._box || !this._box.visible)
        return Clutter.EVENT_PROPAGATE;
      if (this._menuOpen)
        return Clutter.EVENT_PROPAGATE;

      const button = event.get_button();
      if (button !== 1)
        return Clutter.EVENT_PROPAGATE;

      const [clickX, clickY] = event.get_coords();
      const [boxX, boxY] = this._box.get_transformed_position();
      const boxWidth = this._box.width;
      const boxHeight = this._box.height;

      const isInside = 
        clickX >= boxX && clickX <= boxX + boxWidth &&
        clickY >= boxY && clickY <= boxY + boxHeight;

      if (!isInside)
        this._collapseWidget();

      return Clutter.EVENT_PROPAGATE;
    });

    // Listener per cambio finestra attiva (cattura click su altre app)
    this._focusWindowChangedId = global.display.connect('notify::focus-window', () => {
      if (!this._settings.get_boolean(KEY_COLLAPSED))
        return;
      if (!this._expanded || !this._box || !this._box.visible)
        return;
      if (this._menuOpen)
        return;

      const focusWin = global.display.get_focus_window
        ? global.display.get_focus_window()
        : global.display.focus_window;

      // Se c'è una finestra attiva (non desktop), collassa
      if (focusWin)
        this._collapseWidget();
    });

    Main.layoutManager.addChrome(this._box);

    // restore geometry
    this._box.set_position(this._settings.get_int('x'), this._settings.get_int('y'));
    this._box.set_size(this._settings.get_int('w'), this._settings.get_int('h'));

    // ---- Drag/resize ----
    this._dragging = false;
    this._resizing = false;

    this._titlePressId = this._titleBar.connect('button-press-event', (actor, event) => {
      if (!this._settings.get_boolean(KEY_EDIT))
        return Clutter.EVENT_PROPAGATE;
      this._dragging = true;
      [this._dragStartX, this._dragStartY] = event.get_coords();
      [this._dragStartPosX, this._dragStartPosY] = [this._box.x, this._box.y];
      return Clutter.EVENT_STOP;
    });

    this._handlePressId = this._resizeHandle.connect('button-press-event', (actor, event) => {
      if (!this._settings.get_boolean(KEY_EDIT))
        return Clutter.EVENT_PROPAGATE;
      this._resizing = true;
      [this._resizeStartX, this._resizeStartY] = event.get_coords();
      [this._resizeStartW, this._resizeStartH] = [this._box.width, this._box.height];
      return Clutter.EVENT_STOP;
    });

    this._motionId = global.stage.connect('motion-event', (actor, event) => {
      if (!this._settings.get_boolean(KEY_EDIT))
        return Clutter.EVENT_PROPAGATE;

      if (this._dragging) {
        const [x, y] = event.get_coords();
        this._box.set_position(
          Math.max(0, this._dragStartPosX + (x - this._dragStartX)),
          Math.max(0, this._dragStartPosY + (y - this._dragStartY))
        );
        return Clutter.EVENT_STOP;
      }

      if (this._resizing) {
        const [x, y] = event.get_coords();
        const newH = Math.max(120, this._resizeStartH + (y - this._resizeStartY));
        this._box.set_size(
          Math.max(220, this._resizeStartW + (x - this._resizeStartX)),
          newH
        );
        this._settings.set_int('h', newH);
        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    });

    this._releaseId = global.stage.connect('button-release-event', () => {
      if (!this._settings.get_boolean(KEY_EDIT))
        return Clutter.EVENT_PROPAGATE;

      if (this._dragging || this._resizing) {
        this._dragging = false;
        this._resizing = false;
        this._settings.set_int('x', this._box.x);
        this._settings.set_int('y', this._box.y);
        this._settings.set_int('w', this._box.width);
        this._settings.set_int('h', this._box.height);
        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    });

    // ---- Panel indicator ----
    this._indicator = new PanelMenu.Button(0.0, 'Desktop Folder Widget');
    const panelBox = new St.BoxLayout();
    const panelIcon = new St.Icon({
      icon_name: 'user-desktop-symbolic',
      style_class: 'system-status-icon',
    });
    panelBox.add_child(panelIcon);
    this._indicator.add_child(panelBox);

    // Menu: visibility toggle
    this._visibleItem = new PopupMenu.PopupSwitchMenuItem(
      'Mostra widget',
      this._settings.get_boolean(KEY_VISIBLE)
    );
    this._visibleItem.connect('toggled', (item, state) => {
      this._settings.set_boolean(KEY_VISIBLE, state);
    });
    this._indicator.menu.addMenuItem(this._visibleItem);

    // Menu: collapsed toggle
    this._collapsedItem = new PopupMenu.PopupSwitchMenuItem(
      'Auto-hide (click per espandere)',
      this._settings.get_boolean(KEY_COLLAPSED)
    );
    this._collapsedItem.connect('toggled', (item, state) => {
      this._settings.set_boolean(KEY_COLLAPSED, state);
      if (state) {
        this._expanded = true;
        this._collapseWidget();
      } else {
        this._expanded = false;
        this._expandWidget();
      }
    });
    this._indicator.menu.addMenuItem(this._collapsedItem);

    // Keybinding per toggle
    this._settings.set_strv('toggle-shortcut', this._settings.get_strv('toggle-shortcut'));
    Main.wm.addKeybinding(
      'toggle-shortcut',
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL,
      () => {
        const currentCollapsed = this._settings.get_boolean(KEY_COLLAPSED);

        if (currentCollapsed) {
          if (this._expanded)
            this._collapseWidget();
          else
            this._expandWidget();
        } else {
          this._settings.set_boolean(KEY_COLLAPSED, true);
          this._expanded = true;
          this._collapseWidget();
        }
      }
    );

    // Menu: edit mode toggle
    this._editItem = new PopupMenu.PopupSwitchMenuItem(
      'Edit mode (drag/resize)',
      this._settings.get_boolean(KEY_EDIT)
    );
    this._editItem.connect('toggled', (item, state) => {
      this._settings.set_boolean(KEY_EDIT, state);
    });
    this._indicator.menu.addMenuItem(this._editItem);

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    // ---- Settings watchers ----
    this._editChangedId = this._settings.connect(`changed::${KEY_EDIT}`, () => {
      const state = this._settings.get_boolean(KEY_EDIT);
      this._editItem.setToggleState(state);
      this._applyEditMode(state);
    });

    this._visibleChangedId = this._settings.connect(`changed::${KEY_VISIBLE}`, () => {
      const state = this._settings.get_boolean(KEY_VISIBLE);
      this._visibleItem.setToggleState(state);
      this._applyVisibility(state);
    });

    this._collapsedChangedId = this._settings.connect(`changed::${KEY_COLLAPSED}`, () => {
      const state = this._settings.get_boolean(KEY_COLLAPSED);
      this._collapsedItem.setToggleState(state);
    });

    // ---- Keybindings ----
    Main.wm.addKeybinding(
      'toggle-edit-shortcut',
      this._settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => this._settings.set_boolean(KEY_EDIT, !this._settings.get_boolean(KEY_EDIT))
    );

    Main.wm.addKeybinding(
      'toggle-visible-shortcut',
      this._settings,
      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => this._settings.set_boolean(KEY_VISIBLE, !this._settings.get_boolean(KEY_VISIBLE))
    );

    // Apply initial state
    this._applyEditMode(this._settings.get_boolean(KEY_EDIT));

    // Visibilità iniziale
    const isVisible = this._settings.get_boolean(KEY_VISIBLE);
    this._box.visible = isVisible;
    this._box.opacity = isVisible ? 255 : 0;

    if (this._settings.get_boolean(KEY_COLLAPSED)) {
      this._box.set_height(this._collapsedHeight);
      this._list.visible = false;
      this._bottomBar.visible = false;
      this._searchEntry.visible = false;
      this._expanded = false;
      this._applyCollapsedState(true);
    }

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._applyVisibility(this._settings.get_boolean(KEY_VISIBLE));
      return GLib.SOURCE_REMOVE;
    });

    // list + monitor
    this._refresh();
    this._monitor = this._currentDir.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
    this._monitorChangedId = this._monitor.connect('changed', () => this._refresh());
  }

  disable() {
    Main.wm.removeKeybinding('toggle-edit-shortcut');
    Main.wm.removeKeybinding('toggle-visible-shortcut');
    Main.wm.removeKeybinding('toggle-shortcut');

    this._menuOpen = false;

    if (this._editChangedId && this._settings)
      this._settings.disconnect(this._editChangedId);
    this._editChangedId = null;

    if (this._visibleChangedId && this._settings)
      this._settings.disconnect(this._visibleChangedId);
    this._visibleChangedId = null;

    if (this._collapsedChangedId && this._settings)
      this._settings.disconnect(this._collapsedChangedId);
    this._collapsedChangedId = null;

    if (this._monitorChangedId && this._monitor) {
      this._monitor.disconnect(this._monitorChangedId);
      this._monitorChangedId = null;
    }

    if (this._focusWindowChangedId) {
      global.display.disconnect(this._focusWindowChangedId);
      this._focusWindowChangedId = null;
    }

    this._monitor?.cancel();
    this._monitor = null;

    if (this._openBtnPressId) this._openBtn?.disconnect(this._openBtnPressId);
    this._openBtnPressId = null;

    if (this._stageClickId) global.stage.disconnect(this._stageClickId);
    this._stageClickId = null;

    if (this._titlePressId) this._titleBar?.disconnect(this._titlePressId);
    this._titlePressId = null;

    if (this._handlePressId) this._resizeHandle?.disconnect(this._handlePressId);
    this._handlePressId = null;

    if (this._motionId) global.stage.disconnect(this._motionId);
    this._motionId = null;

    if (this._releaseId) global.stage.disconnect(this._releaseId);
    this._releaseId = null;

    if (this._currentContextMenu) {
      this._currentContextMenu.close(false);
      this._currentContextMenu.destroy();
      this._currentContextMenu = null;
    }

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    if (this._box) {
      Main.layoutManager.removeChrome(this._box);
      this._box.destroy();
      this._box = null;
    }

    this._openIcon = null;
    this._openBtn = null;
    this._backBtn = null;
    this._titleLabel = null;
    this._titleBar = null;
    this._searchEntry = null;
    this._scrollView = null;
    this._list = null;
    this._resizeHandle = null;
    this._bottomBar = null;
    this._collapsedItem = null;
    this._currentDir = null;
    this._dirStack = null;
    this._settings = null;
  }

  // Metodo helper per aprire URI in modo sicuro
  _openUri(uri) {
    try {
      const context = global.create_app_launch_context(0, -1);
      Gio.AppInfo.launch_default_for_uri(uri, context);
    } catch (e) {
      logError(e, `Failed to open URI: ${uri}`);
    }
  }

  _applyEditMode(enabled) {
    if (!this._box) return;
    this._titleBar.reactive = enabled;
    this._resizeHandle.visible = enabled;
    this._box.reactive = true;
    this._box.can_focus = enabled;
    this._box.track_hover = true;
  }

  _applyVisibility(visible) {
    if (!this._box) return;
    this._box.remove_all_transitions();

    if (visible) {
      this._box.opacity = 0;
      this._box.visible = true;
      this._box.ease({
        opacity: 255,
        duration: 300,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    } else {
      this._box.ease({
        opacity: 0,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => {
          this._box.visible = false;
          if (this._settings.get_boolean(KEY_EDIT)) {
            this._settings.set_boolean(KEY_EDIT, false);
          }
        },
      });
    }
  }

  _applyCollapsedState(collapsed) {
    if (!this._box) return;

    if (collapsed) {
      Main.layoutManager.removeChrome(this._box);
      Main.layoutManager.addChrome(this._box, {
        affectsStruts: false,
        trackFullscreen: false,
        affectsInputRegion: false,
      });

      this._titleLabel.visible = false;
      this._searchEntry.visible = false;
      this._backBtn.visible = false;

      this._titleBar.set_style('margin-bottom: 0; justify-content: center;');

      const spacer = this._titleBar.get_child_at_index(2);
      if (spacer) spacer.visible = false;

      this._openIcon.icon_name = 'user-desktop-symbolic';
      this._openIcon.set_style('icon-size: 24px; color: #83a598;');

      this._openBtn.set_style(`
        padding: 10px;
        border-radius: 999px;
        background-color: rgba(0,0,0,0.01);
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      `);

      this._titleBar.reactive = false;
      this._list.reactive = false;
      this._searchEntry.reactive = false;
      this._box.reactive = false;
      this._openBtn.reactive = true;

      this._box.set_style(`
        padding: 0px;
        background-color: transparent;
        border: none;
        box-shadow: none;
      `);

      this._box.set_height(48);
      this._box.set_width(48);

    } else {
      Main.layoutManager.removeChrome(this._box);
      Main.layoutManager.addChrome(this._box, {
        affectsStruts: false,
        trackFullscreen: false,
        affectsInputRegion: true,
      });

      this._titleLabel.visible = true;
      this._searchEntry.visible = true;
      this._backBtn.visible = this._dirStack.length > 0;
      this._titleBar.set_style('margin-bottom: 6px;');

      const spacer = this._titleBar.get_child_at_index(2);
      if (spacer) spacer.visible = true;

      this._openIcon.icon_name = 'folder-open-symbolic';
      this._openIcon.set_style('icon-size: 14px; color: #83a598;');
      this._openBtn.set_style(`
        padding: 3px;
        border-radius: 6px;
        background-color: rgba(255,255,255,0.10);
      `);

      this._titleBar.reactive = true;
      this._list.reactive = true;
      this._searchEntry.reactive = true;
      this._box.reactive = true;
      this._openBtn.reactive = true;

      this._box.set_width(this._settings.get_int('w'));
      this._box.set_height(-1);

      this._box.set_style(`
        padding: 12px;
        border-radius: 12px;
        background-color: rgba(0,0,0,0.60);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.12);
      `);
    }
  }

  _expandWidget() {
    if (this._expanded || !this._box) return;
    this._expanded = true;

    this._applyCollapsedState(false);
    this._list.visible = true;
    this._bottomBar.visible = true;

    const targetHeight = this._settings.get_int('h');
    this._box.remove_all_transitions();
    this._box.ease({
      height: targetHeight,
      duration: 200,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _collapseWidget() {
    if (!this._expanded || !this._box) return;
    this._expanded = false;

    this._applyCollapsedState(true);

    this._box.remove_all_transitions();
    this._box.ease({
      height: this._collapsedHeight,
      duration: 150,
      mode: Clutter.AnimationMode.EASE_IN_QUAD,
      onComplete: () => {
        this._list.visible = false;
        this._bottomBar.visible = false;
      },
    });
  }

  _navigateInto(dir) {
    this._dirStack.push(this._currentDir);
    this._currentDir = dir;

    if (this._monitor) {
      this._monitor.cancel();
      this._monitor = null;
    }
    this._monitor = this._currentDir.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
    if (this._monitorChangedId) this._monitor.disconnect(this._monitorChangedId);
    this._monitorChangedId = this._monitor.connect('changed', () => this._refresh());

    this._updateBreadcrumb();
    this._refresh();
  }

  _navigateBack() {
    if (this._dirStack.length === 0) return;

    this._currentDir = this._dirStack.pop();

    if (this._monitor) {
      this._monitor.cancel();
      this._monitor = null;
    }
    this._monitor = this._currentDir.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
    if (this._monitorChangedId) this._monitor.disconnect(this._monitorChangedId);
    this._monitorChangedId = this._monitor.connect('changed', () => this._refresh());

    this._updateBreadcrumb();
    this._refresh();
  }

  _updateBreadcrumb() {
    const homePath = GLib.get_home_dir();
    const currentPath = this._currentDir.get_path();

    if (currentPath === homePath)
      this._titleLabel.text = 'Home';
    else
      this._titleLabel.text = GLib.path_get_basename(currentPath);

    this._backBtn.visible = this._dirStack.length > 0;
  }

  _showContextMenu(sourceActor, filePath, fileName, isDir) {
    if (this._currentContextMenu) {
      this._currentContextMenu.close(false);
      this._currentContextMenu.destroy();
      this._currentContextMenu = null;
    }

    this._menuOpen = true;

    const menu = new PopupMenu.PopupMenu(sourceActor, 0.0, St.Side.TOP);
    this._currentContextMenu = menu;
    Main.uiGroup.add_child(menu.actor);
    menu.actor.hide();

    menu.addAction('Apri', () => {
      const file = Gio.File.new_for_path(filePath);
      this._openUri(file.get_uri());
    });

    menu.addAction('Mostra in Files', () => {
      const parentPath = GLib.path_get_dirname(filePath);
      const parentFile = Gio.File.new_for_path(parentPath);
      this._openUri(parentFile.get_uri());
    });

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    menu.addAction('Copia percorso', () => {
      const clipboard = St.Clipboard.get_default();
      clipboard.set_text(St.ClipboardType.CLIPBOARD, filePath);
    });

    menu.addAction('Rinomina...', () => {
      const parentPath = GLib.path_get_dirname(filePath);
      this._openUri(Gio.File.new_for_path(parentPath).get_uri());
    });

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    menu.addAction('Sposta nel cestino', () => {
      try {
        const file = Gio.File.new_for_path(filePath);
        file.trash(null);
        this._refresh();
      } catch (e) {
        logError(e, `Failed to trash: ${fileName}`);
      }
    });

    menu.open(true);

    const closeId = menu.connect('open-state-changed', (menu, open) => {
      if (!open) {
        menu.disconnect(closeId);
        menu.destroy();
        if (this._currentContextMenu === menu)
          this._currentContextMenu = null;
        this._menuOpen = false;
      }
    });
  }

  _refresh() {
    if (!this._list)
      return;

    this._list.destroy_all_children();

    try {
      const enumerator = this._currentDir.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
      );

      const items = [];
      let info;

      const searchText = this._settings.get_string('search-text').toLowerCase();

      while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        if (name.startsWith('.'))
          continue;

        if (searchText && !name.toLowerCase().includes(searchText))
          continue;

        const ftype = info.get_file_type();
        const isDir = ftype === Gio.FileType.DIRECTORY;
        const fullPath = GLib.build_filenamev([
          this._currentDir.get_path(),
          name
        ]);

        items.push({name, path: fullPath, isDir});
      }

      items.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const it of items) {
        const btn = new St.Button({
          style_class: 'desktop-file-button',
          x_align: Clutter.ActorAlign.START,
          style: `
            padding: 2px 4px;
            border-radius: 4px;
            background-color: transparent;
          `,
        });

        const itemBox = new St.BoxLayout({
          vertical: false,
          style: 'spacing: 6px;',
        });

        const icon = new St.Icon({
          icon_name: it.isDir ? 'folder-symbolic' : 'text-x-generic-symbolic',
          icon_size: 16,
          style: `color: ${it.isDir ? '#83a598' : '#d3869b'};`,
        });

        const label = new St.Label({
          text: it.name,
          style: 'padding: 0;',
          y_align: Clutter.ActorAlign.CENTER,
        });

        itemBox.add_child(icon);
        itemBox.add_child(label);
        btn.set_child(itemBox);

        btn.connect('enter-event', () => {
          btn.set_style(`
            padding: 2px 4px;
            border-radius: 4px;
            background-color: rgba(255,255,255,0.15);
          `);
        });

        btn.connect('leave-event', () => {
          btn.set_style(`
            padding: 2px 4px;
            border-radius: 4px;
            background-color: transparent;
          `);
        });

        btn.connect('clicked', () => {
          const file = Gio.File.new_for_path(it.path);

          if (it.isDir) {
            this._navigateInto(file);
          } else {
            this._openUri(file.get_uri());
          }
        });

        btn.connect('button-press-event', (actor, event) => {
          if (event.get_button() === 3) {
            this._showContextMenu(btn, it.path, it.name, it.isDir);
            return Clutter.EVENT_STOP;
          }
          return Clutter.EVENT_PROPAGATE;
        });

        this._list.add_child(btn);
      }

      if (items.length === 0 && searchText) {
        this._list.add_child(new St.Label({
          text: 'Nessun risultato',
          style: 'font-style: italic; opacity: 0.6;'
        }));
      }

    } catch (e) {
      this._list.add_child(new St.Label({text: `Errore: ${e.message}`}));
    }
  }
}
