import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
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

    this._currentDir = Gio.File.new_for_path(GLib.get_home_dir());
    this._dirStack = [];

    // ---- Widget ----
    this._box = new St.BoxLayout({
      vertical: true,
      reactive: true,
      can_focus: true,
      track_hover: true,
      style_class: 'desktop-folder-widget',
    });

    // Titlebar
    this._titleBar = new St.BoxLayout({
      vertical: false,
      style_class: 'desktop-folder-titlebar',
    });

    this._backBtn = new St.Button({
      reactive: true,
      can_focus: true,
      track_hover: true,
      visible: false,
      style_class: 'desktop-folder-nav-btn',
      child: new St.Icon({
        icon_name: 'go-previous-symbolic',
        style_class: 'desktop-folder-nav-icon',
      }),
    });
    this._backBtn.connect('clicked', () => this._navigateBack());

    this._homeBtn = new St.Button({
      reactive: true,
      can_focus: true,
      track_hover: true,
      visible: false,
      style_class: 'desktop-folder-nav-btn',
      child: new St.Icon({
        icon_name: 'go-home-symbolic',
        style_class: 'desktop-folder-nav-icon',
      }),
    });
    this._homeBtn.connect('clicked', () => this._navigateHome());

    this._titleLabel = new St.Label({
      text: _('Home'),
      style_class: 'desktop-folder-title',
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._openBtn = new St.Button({
      reactive: true,
      can_focus: true,
      track_hover: true,
      style_class: 'desktop-folder-open-btn',
    });
    this._openIcon = new St.Icon({
      icon_name: 'folder-open-symbolic',
      style_class: 'desktop-folder-open-icon',
    });
    this._openBtn.set_child(this._openIcon);

    // Spacer esplicito con riferimento diretto (evita get_child_at_index)
    this._titleSpacer = new St.Widget({x_expand: true});

    this._titleBar.add_child(this._backBtn);
    this._titleBar.add_child(this._homeBtn);
    this._titleBar.add_child(this._titleLabel);
    this._titleBar.add_child(this._titleSpacer);
    this._titleBar.add_child(this._openBtn);

    // Campo ricerca
    this._searchEntry = new St.Entry({
      hint_text: _('Search…'),
      can_focus: true,
      track_hover: true,
      style_class: 'desktop-folder-search',
    });

    this._searchEntry.clutter_text.connect('text-changed', () => {
      const text = this._searchEntry.get_text();
      this._settings.set_string('search-text', text);
      this._refresh();
    });

    this._searchEntry.clutter_text.connect('key-press-event', (_actor, event) => {
      if (event.get_key_symbol() === Clutter.KEY_Escape) {
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
      style_class: 'desktop-folder-resize-handle',
    });

    this._bottomBar = new St.BoxLayout({
      vertical: false,
      style_class: 'desktop-folder-bottombar',
    });
    this._bottomBar.add_child(new St.Widget({x_expand: true}));
    this._bottomBar.add_child(this._resizeHandle);

    // Scroll view — policy impostata tramite proprietà in GNOME 45+
    this._scrollView = new St.ScrollView({
      style_class: 'desktop-folder-scrollview',
      overlay_scrollbars: true,
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
    });

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

    this._expanded = true;
    this._collapsedHeight = 44;

    // Toggle expand/collapse sul bottone open (usa 'clicked' invece di button-press-event)
    this._openBtnClickId = this._openBtn.connect('clicked', () => {
      if (this._settings.get_boolean(KEY_COLLAPSED)) {
        if (this._expanded)
          this._collapseWidget();
        else
          this._expandWidget();
      } else if (!this._settings.get_boolean(KEY_EDIT)) {
        this._openUri(this._currentDir.get_uri());
      }
    });

    // Auto-collapse su click fuori — usa focus-window invece di stage button-press-event
    this._focusWindowChangedId = global.display.connect('notify::focus-window', () => {
      if (!this._settings.get_boolean(KEY_COLLAPSED))
        return;
      if (!this._expanded || !this._box || !this._box.visible)
        return;
      if (this._menuOpen)
        return;
      const focusWin = global.display.focus_window;
      if (focusWin)
        this._collapseWidget();
    });

    Main.layoutManager.addChrome(this._box);

    // Restore geometry
    this._box.set_position(this._settings.get_int('x'), this._settings.get_int('y'));
    this._box.set_size(this._settings.get_int('w'), this._settings.get_int('h'));

    // ---- Drag/resize via Clutter actions (sostituisce motion/button-press/release su stage) ----
    this._dragging = false;
    this._resizing = false;

    // Drag action sul titleBar
    this._dragAction = new Clutter.GestureAction();
    this._dragAction.set_n_touch_points(1);
    this._titleBar.add_action(this._dragAction);

    this._dragAction.connect('gesture-begin', (_action, actor) => {
      if (!this._settings.get_boolean(KEY_EDIT))
        return false;
      this._dragging = true;
      [this._dragStartPosX, this._dragStartPosY] = [this._box.x, this._box.y];
      return true;
    });

    this._dragAction.connect('gesture-progress', () => {
      if (!this._dragging) return true;
      const [mx, my] = this._dragAction.get_motion_coords(0);
      const [px, py] = this._dragAction.get_press_coords(0);
      this._box.set_position(
        Math.max(0, this._dragStartPosX + (mx - px)),
        Math.max(0, this._dragStartPosY + (my - py))
      );
      return true;
    });

    this._dragAction.connect('gesture-end', () => {
      if (!this._dragging) return;
      this._dragging = false;
      this._settings.set_int('x', this._box.x);
      this._settings.set_int('y', this._box.y);
    });

    this._dragAction.connect('gesture-cancel', () => {
      this._dragging = false;
    });

    // Resize action sull'handle
    this._resizeAction = new Clutter.GestureAction();
    this._resizeAction.set_n_touch_points(1);
    this._resizeHandle.add_action(this._resizeAction);

    this._resizeAction.connect('gesture-begin', () => {
      if (!this._settings.get_boolean(KEY_EDIT))
        return false;
      this._resizing = true;
      [this._resizeStartW, this._resizeStartH] = [this._box.width, this._box.height];
      return true;
    });

    this._resizeAction.connect('gesture-progress', () => {
      if (!this._resizing) return true;
      const [mx, my] = this._resizeAction.get_motion_coords(0);
      const [px, py] = this._resizeAction.get_press_coords(0);
      const newW = Math.max(220, this._resizeStartW + (mx - px));
      const newH = Math.max(120, this._resizeStartH + (my - py));
      this._box.set_size(newW, newH);
      return true;
    });

    this._resizeAction.connect('gesture-end', () => {
      if (!this._resizing) return;
      this._resizing = false;
      this._settings.set_int('w', this._box.width);
      this._settings.set_int('h', this._box.height);
    });

    this._resizeAction.connect('gesture-cancel', () => {
      this._resizing = false;
    });

    // ---- Panel indicator ----
    this._indicator = new PanelMenu.Button(0.0, _('Desktop Folder Widget'));
    const panelBox = new St.BoxLayout();
    panelBox.add_child(new St.Icon({
      icon_name: 'user-desktop-symbolic',
      style_class: 'system-status-icon',
    }));
    this._indicator.add_child(panelBox);

    this._visibleItem = new PopupMenu.PopupSwitchMenuItem(
      _('Show widget'),
      this._settings.get_boolean(KEY_VISIBLE)
    );
    this._visibleItem.connect('toggled', (_item, state) => {
      this._settings.set_boolean(KEY_VISIBLE, state);
    });
    this._indicator.menu.addMenuItem(this._visibleItem);

    this._collapsedItem = new PopupMenu.PopupSwitchMenuItem(
      _('Auto-hide (click to expand)'),
      this._settings.get_boolean(KEY_COLLAPSED)
    );
    this._collapsedItem.connect('toggled', (_item, state) => {
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

    this._editItem = new PopupMenu.PopupSwitchMenuItem(
      _('Edit mode (drag/resize)'),
      this._settings.get_boolean(KEY_EDIT)
    );
    this._editItem.connect('toggled', (_item, state) => {
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
      'toggle-shortcut',
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL,
      () => {
        if (this._settings.get_boolean(KEY_COLLAPSED)) {
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

    // List + monitor
    this._refresh();
    this._startMonitor();
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

    this._stopMonitor();

    if (this._focusWindowChangedId) {
      global.display.disconnect(this._focusWindowChangedId);
      this._focusWindowChangedId = null;
    }

    if (this._currentContextMenu) {
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
    this._homeBtn = null;
    this._titleLabel = null;
    this._titleSpacer = null;
    this._titleBar = null;
    this._searchEntry = null;
    this._scrollView = null;
    this._list = null;
    this._resizeHandle = null;
    this._bottomBar = null;
    this._collapsedItem = null;
    this._visibleItem = null;
    this._editItem = null;
    this._currentDir = null;
    this._dirStack = null;
    this._dragAction = null;
    this._resizeAction = null;
    this._settings = null;
  }

  // ---- Monitor helpers (fix race condition: disconnect PRIMA di cancel) ----

  _stopMonitor() {
    if (this._monitorChangedId && this._monitor) {
      this._monitor.disconnect(this._monitorChangedId);
      this._monitorChangedId = null;
    }
    if (this._monitor) {
      this._monitor.cancel();
      this._monitor = null;
    }
  }

  _startMonitor() {
    this._stopMonitor();
    this._monitor = this._currentDir.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
    this._monitorChangedId = this._monitor.connect('changed', () => this._refresh());
  }

  // ---- URI helper ----

  _openUri(uri) {
    try {
      const context = global.create_app_launch_context(0, -1);
      Gio.AppInfo.launch_default_for_uri(uri, context);
    } catch (e) {
      console.error(`[DesktopFolderWidget] Failed to open URI: ${uri}`, e);
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
          if (!this._box) return;
          this._box.visible = false;
          if (this._settings?.get_boolean(KEY_EDIT))
            this._settings.set_boolean(KEY_EDIT, false);
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
      this._homeBtn.visible = false;
      this._titleSpacer.visible = false;

      this._titleBar.style_class = 'desktop-folder-titlebar desktop-folder-titlebar-collapsed';
      this._openIcon.icon_name = 'user-desktop-symbolic';
      this._openIcon.style_class = 'desktop-folder-open-icon desktop-folder-open-icon-collapsed';
      this._openBtn.style_class = 'desktop-folder-open-btn desktop-folder-open-btn-collapsed';

      this._titleBar.reactive = false;
      this._list.reactive = false;
      this._searchEntry.reactive = false;
      this._box.reactive = false;
      this._openBtn.reactive = true;

      this._box.style_class = 'desktop-folder-widget desktop-folder-widget-collapsed';
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
      this._homeBtn.visible = this._dirStack.length > 0;
      this._titleSpacer.visible = true;

      this._titleBar.style_class = 'desktop-folder-titlebar';
      this._openIcon.icon_name = 'folder-open-symbolic';
      this._openIcon.style_class = 'desktop-folder-open-icon';
      this._openBtn.style_class = 'desktop-folder-open-btn';

      this._titleBar.reactive = true;
      this._list.reactive = true;
      this._searchEntry.reactive = true;
      this._box.reactive = true;
      this._openBtn.reactive = true;

      this._box.style_class = 'desktop-folder-widget';
      this._box.set_width(this._settings.get_int('w'));
      this._box.set_height(-1);
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
        if (!this._list) return;
        this._list.visible = false;
        this._bottomBar.visible = false;
      },
    });
  }

  _navigateInto(dir) {
    this._dirStack.push(this._currentDir);
    this._currentDir = dir;
    this._startMonitor();
    this._updateBreadcrumb();
    this._refresh();
  }

  _navigateBack() {
    if (this._dirStack.length === 0) return;
    this._currentDir = this._dirStack.pop();
    this._startMonitor();
    this._updateBreadcrumb();
    this._refresh();
  }

  _navigateHome() {
    if (this._dirStack.length === 0) return;
    this._dirStack = [];
    this._currentDir = Gio.File.new_for_path(GLib.get_home_dir());
    this._startMonitor();
    this._updateBreadcrumb();
    this._refresh();
  }

  _updateBreadcrumb() {
    const homePath = GLib.get_home_dir();
    const currentPath = this._currentDir.get_path();

    this._titleLabel.text = currentPath === homePath
      ? _('Home')
      : GLib.path_get_basename(currentPath);

    this._backBtn.visible = this._dirStack.length > 0;
    this._homeBtn.visible = this._dirStack.length > 0;
  }

  // ---- Context menu custom (non usa PopupMenu su attori arbitrari) ----

  _showContextMenu(sourceActor, filePath, fileName, _isDir) {
    if (this._currentContextMenu) {
      this._currentContextMenu.destroy();
      this._currentContextMenu = null;
    }

    this._menuOpen = true;

    // BoxPointer-free: usiamo un St.Widget come menu custom
    const menuBox = new St.BoxLayout({
      vertical: true,
      style_class: 'desktop-folder-context-menu',
      reactive: true,
    });

    const actions = [
      {label: _('Open'), cb: () => {
        this._openUri(Gio.File.new_for_path(filePath).get_uri());
      }},
      {label: _('Show in Files'), cb: () => {
        const parent = Gio.File.new_for_path(filePath).get_parent();
        if (parent) this._openUri(parent.get_uri());
      }},
      null, // separatore
      {label: _('Copy path'), cb: () => {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, filePath);
      }},
      null,
      {label: _('Move to Trash'), cb: () => {
        try {
          Gio.File.new_for_path(filePath).trash(null);
          this._refresh();
        } catch (e) {
          console.error(`[DesktopFolderWidget] Failed to trash ${fileName}`, e);
        }
      }},
    ];

    for (const action of actions) {
      if (action === null) {
        menuBox.add_child(new St.Widget({style_class: 'desktop-folder-menu-separator'}));
        continue;
      }
      const item = new St.Button({
        label: action.label,
        style_class: 'desktop-folder-menu-item',
        x_align: Clutter.ActorAlign.START,
      });
      item.connect('clicked', () => {
        this._closeContextMenu();
        action.cb();
      });
      menuBox.add_child(item);
    }

    // Posiziona il menu vicino all'attore sorgente
    const menuActor = new St.Bin({
      style_class: 'desktop-folder-context-popup',
      child: menuBox,
    });
    Main.uiGroup.add_child(menuActor);

    const [ax, ay] = sourceActor.get_transformed_position();
    const monitor = Main.layoutManager.primaryMonitor;
    const mw = menuActor.width || 180;
    const mh = menuActor.height || 160;
    const mx = Math.min(ax, monitor.x + monitor.width - mw - 8);
    const my = Math.min(ay + sourceActor.height, monitor.y + monitor.height - mh - 8);
    menuActor.set_position(Math.max(monitor.x + 8, mx), Math.max(monitor.y + 8, my));

    this._currentContextMenu = menuActor;

    // Chiudi cliccando fuori
    this._menuDismissId = global.stage.connect('button-press-event', (_stage, event) => {
      const [cx, cy] = event.get_coords();
      const [bx, by] = menuActor.get_transformed_position();
      const inside = cx >= bx && cx <= bx + menuActor.width &&
                     cy >= by && cy <= by + menuActor.height;
      if (!inside)
        this._closeContextMenu();
      return Clutter.EVENT_PROPAGATE;
    });
  }

  _closeContextMenu() {
    if (this._menuDismissId) {
      global.stage.disconnect(this._menuDismissId);
      this._menuDismissId = null;
    }
    if (this._currentContextMenu) {
      this._currentContextMenu.destroy();
      this._currentContextMenu = null;
    }
    this._menuOpen = false;
  }

  // ---- Refresh asincrono (non blocca il main loop) ----

  _refresh() {
    if (!this._list) return;

    // Cancella eventuale refresh in corso
    if (this._refreshCancellable) {
      this._refreshCancellable.cancel();
      this._refreshCancellable = null;
    }

    const cancellable = new Gio.Cancellable();
    this._refreshCancellable = cancellable;

    const searchText = this._settings.get_string('search-text').toLowerCase();

    this._currentDir.enumerate_children_async(
      'standard::name,standard::type',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      GLib.PRIORITY_DEFAULT,
      cancellable,
      (_source, result) => {
        if (cancellable.is_cancelled()) return;
        if (!this._list) return;

        let enumerator;
        try {
          enumerator = this._currentDir.enumerate_children_finish(result);
        } catch (e) {
          if (!this._list) return;
          this._list.destroy_all_children();
          this._list.add_child(new St.Label({
            text: `Error: ${e.message}`,
            style_class: 'desktop-folder-error',
          }));
          return;
        }

        this._readNextFiles(enumerator, cancellable, searchText, []);
      }
    );
  }

  _readNextFiles(enumerator, cancellable, searchText, items) {
    enumerator.next_files_async(
      20, // batch size
      GLib.PRIORITY_DEFAULT,
      cancellable,
      (_source, result) => {
        if (cancellable.is_cancelled()) {
          enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
          return;
        }
        if (!this._list) {
          enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
          return;
        }

        let infos;
        try {
          infos = enumerator.next_files_finish(result);
        } catch (e) {
          enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
          return;
        }

        if (infos.length === 0) {
          // Fine della lista
          enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
          this._renderFileList(items, searchText);
          return;
        }

        for (const info of infos) {
          const name = info.get_name();
          if (name.startsWith('.')) continue;
          if (searchText && !name.toLowerCase().includes(searchText)) continue;

          const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
          const fullPath = GLib.build_filenamev([this._currentDir.get_path(), name]);
          items.push({name, path: fullPath, isDir});
        }

        // Leggi il batch successivo
        this._readNextFiles(enumerator, cancellable, searchText, items);
      }
    );
  }

  _renderFileList(items, searchText) {
    if (!this._list) return;

    this._list.destroy_all_children();

    items.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const it of items) {
      const btn = new St.Button({
        style_class: 'desktop-folder-file-btn',
        x_align: Clutter.ActorAlign.START,
      });

      const itemBox = new St.BoxLayout({
        vertical: false,
        style_class: 'desktop-folder-file-row',
      });

      const icon = new St.Icon({
        icon_name: it.isDir ? 'folder-symbolic' : 'text-x-generic-symbolic',
        icon_size: 16,
        style_class: it.isDir
          ? 'desktop-folder-file-icon desktop-folder-file-icon-dir'
          : 'desktop-folder-file-icon desktop-folder-file-icon-file',
      });

      const label = new St.Label({
        text: it.name,
        style_class: 'desktop-folder-file-label',
        y_align: Clutter.ActorAlign.CENTER,
      });

      itemBox.add_child(icon);
      itemBox.add_child(label);
      btn.set_child(itemBox);

      btn.connect('enter-event', () => {
        btn.add_style_class_name('desktop-folder-file-btn-hover');
      });
      btn.connect('leave-event', () => {
        btn.remove_style_class_name('desktop-folder-file-btn-hover');
      });

      btn.connect('clicked', () => {
        if (it.isDir)
          this._navigateInto(Gio.File.new_for_path(it.path));
        else
          this._openUri(Gio.File.new_for_path(it.path).get_uri());
      });

      btn.connect('button-press-event', (_actor, event) => {
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
        text: _('No results'),
        style_class: 'desktop-folder-empty',
      }));
    }
  }
}
