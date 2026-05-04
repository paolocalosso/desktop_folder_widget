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
    this._currentDir = Gio.File.new_for_path(GLib.get_home_dir());
    this._dirStack = [];

    this._box = new St.BoxLayout({ vertical: true, reactive: true, can_focus: true, track_hover: true });
    this._box.set_style(`padding: 12px; border-radius: 12px; background-color: rgba(0,0,0,0.60); color: #fff; border: 1px solid rgba(255,255,255,0.12);`);

    this._titleBar = new St.BoxLayout({ vertical: false, style: 'margin-bottom: 6px;' });

    this._backBtn = new St.Button({ reactive: true, can_focus: true, track_hover: true, visible: false, style: `padding: 3px; border-radius: 6px; background-color: rgba(255,255,255,0.10); margin-right: 4px;` });
    this._backBtn.set_child(new St.Icon({ icon_name: 'go-previous-symbolic', style: 'icon-size: 14px; color: #83a598;' }));
    this._backBtn.connect('clicked', () => this._navigateBack());

    this._homeBtn = new St.Button({ reactive: true, can_focus: true, track_hover: true, visible: false, style: `padding: 3px; border-radius: 6px; background-color: rgba(255,255,255,0.10); margin-right: 4px;` });
    this._homeBtn.set_child(new St.Icon({ icon_name: 'go-home-symbolic', style: 'icon-size: 14px; color: #83a598;' }));
    this._homeBtn.connect('clicked', () => this._navigateHome());

    this._titleLabel = new St.Label({ text: 'Home', style: 'font-weight: bold;', y_align: Clutter.ActorAlign.CENTER });

    this._openBtn = new St.Button({ reactive: true, can_focus: true, track_hover: true, style: `padding: 3px; border-radius: 6px; background-color: rgba(255,255,255,0.10);` });
    this._openIcon = new St.Icon({ icon_name: 'folder-open-symbolic', style: 'icon-size: 14px; color: #83a598;' });
    this._openBtn.set_child(this._openIcon);

    this._titleBar.add_child(this._backBtn);
    this._titleBar.add_child(this._homeBtn);
    this._titleBar.add_child(this._titleLabel);
    this._titleBar.add_child(new St.Widget({ x_expand: true }));
    this._titleBar.add_child(this._openBtn);

    this._searchEntry = new St.Entry({ hint_text: 'Cerca...', can_focus: true, track_hover: true, style: `margin-bottom: 6px; padding: 4px 8px; border-radius: 6px; background-color: rgba(255,255,255,0.08); color: #fff;` });
    this._searchEntry.clutter_text.connect('text-changed', () => { this._settings.set_string('search-text', this._searchEntry.get_text()); this._refresh(); });
    this._searchEntry.clutter_text.connect('key-press-event', (actor, event) => {
      if (event.get_key_symbol() === Clutter.KEY_Escape) { this._searchEntry.set_text(''); global.stage.set_key_focus(null); return Clutter.EVENT_STOP; }
      return Clutter.EVENT_PROPAGATE;
    });

    this._resizeHandle = new St.Widget({ reactive: true, can_focus: true, track_hover: true, width: 16, height: 16 });
    this._resizeHandle.set_style('background-color: rgba(255,255,255,0.25); border-radius: 8px;');

    this._bottomBar = new St.BoxLayout({ vertical: false });
    this._bottomBar.add_child(new St.Widget({ x_expand: true }));
    this._bottomBar.add_child(this._resizeHandle);

    this._scrollView = new St.ScrollView({ style_class: 'quick-files-scrollview', overlay_scrollbars: true });
    this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
    this._scrollView.set_style('max-height: 450px;');
    this._scrollView.vscrollbar_policy = St.PolicyType.AUTOMATIC;
    this._scrollView.hscrollbar_policy = St.PolicyType.NEVER;

    this._list = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });
    this._scrollView.set_child(this._list);

    this._box.add_child(this._titleBar);
    this._box.add_child(this._searchEntry);
    this._box.add_child(this._scrollView);
    this._box.add_child(new St.Widget({ y_expand: true }));
    this._box.add_child(this._bottomBar);

    this._expanded = true;
    this._collapsedHeight = 44;

    this._openBtnPressId = this._openBtn.connect('button-press-event', (actor, event) => {
      if (event.get_button() !== 1)
        return Clutter.EVENT_PROPAGATE;
      if (this._settings.get_boolean(KEY_COLLAPSED)) {
        this._expanded ? this._collapseWidget() : this._expandWidget();
        return Clutter.EVENT_STOP;
      }
      if (!this._settings.get_boolean(KEY_EDIT)) {
        this._openUri(this._currentDir.get_uri());
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    this._stageClickId = global.stage.connect('button-press-event', (actor, event) => {
      if (!this._settings.get_boolean(KEY_COLLAPSED) || !this._expanded || !this._box || !this._box.visible || this._menuOpen)
        return Clutter.EVENT_PROPAGATE;
      if (event.get_button() !== 1)
        return Clutter.EVENT_PROPAGATE;
      const [clickX, clickY] = event.get_coords();
      const [boxX, boxY] = this._box.get_transformed_position();
      const isInside = clickX >= boxX && clickX <= boxX + this._box.width && clickY >= boxY && clickY <= boxY + this._box.height;
      if (!isInside) this._collapseWidget();
      return Clutter.EVENT_PROPAGATE;
    });

    this._focusWindowChangedId = global.display.connect('notify::focus-window', () => {
      if (!this._settings.get_boolean(KEY_COLLAPSED) || !this._expanded || !this._box || !this._box.visible || this._menuOpen)
        return;
      const focusWin = global.display.get_focus_window ? global.display.get_focus_window() : global.display.focus_window;
      if (focusWin) this._collapseWidget();
    });

    Main.layoutManager.addChrome(this._box);
    this._box.set_position(this._settings.get_int('x'), this._settings.get_int('y'));
    this._box.set_size(this._settings.get_int('w'), this._settings.get_int('h'));

    this._dragging = false;
    this._resizing = false;
    this._titlePressId = this._titleBar.connect('button-press-event', (actor, event) => {
      if (!this._settings.get_boolean(KEY_EDIT)) return Clutter.EVENT_PROPAGATE;
      this._dragging = true; [this._dragStartX, this._dragStartY] = event.get_coords(); [this._dragStartPosX, this._dragStartPosY] = [this._box.x, this._box.y]; return Clutter.EVENT_STOP;
    });
    this._handlePressId = this._resizeHandle.connect('button-press-event', (actor, event) => {
      if (!this._settings.get_boolean(KEY_EDIT)) return Clutter.EVENT_PROPAGATE;
      this._resizing = true; [this._resizeStartX, this._resizeStartY] = event.get_coords(); [this._resizeStartW, this._resizeStartH] = [this._box.width, this._box.height]; return Clutter.EVENT_STOP;
    });
    this._motionId = global.stage.connect('motion-event', (actor, event) => {
      if (!this._settings.get_boolean(KEY_EDIT)) return Clutter.EVENT_PROPAGATE;
      if (this._dragging) { const [x,y] = event.get_coords(); this._box.set_position(Math.max(0, this._dragStartPosX + (x - this._dragStartX)), Math.max(0, this._dragStartPosY + (y - this._dragStartY))); return Clutter.EVENT_STOP; }
      if (this._resizing) { const [x,y] = event.get_coords(); const newH = Math.max(120, this._resizeStartH + (y - this._resizeStartY)); this._box.set_size(Math.max(220, this._resizeStartW + (x - this._resizeStartX)), newH); this._settings.set_int('h', newH); return Clutter.EVENT_STOP; }
      return Clutter.EVENT_PROPAGATE;
    });
    this._releaseId = global.stage.connect('button-release-event', () => {
      if (!this._settings.get_boolean(KEY_EDIT)) return Clutter.EVENT_PROPAGATE;
      if (this._dragging || this._resizing) { this._dragging = false; this._resizing = false; this._settings.set_int('x', this._box.x); this._settings.set_int('y', this._box.y); this._settings.set_int('w', this._box.width); this._settings.set_int('h', this._box.height); return Clutter.EVENT_STOP; }
      return Clutter.EVENT_PROPAGATE;
    });

    this._indicator = new PanelMenu.Button(0.0, 'Desktop Folder Widget');
    const panelBox = new St.BoxLayout();
    panelBox.add_child(new St.Icon({ icon_name: 'user-desktop-symbolic', style_class: 'system-status-icon' }));
    this._indicator.add_child(panelBox);

    this._visibleItem = new PopupMenu.PopupSwitchMenuItem('Mostra widget', this._settings.get_boolean(KEY_VISIBLE));
    this._visibleItem.connect('toggled', (item, state) => this._settings.set_boolean(KEY_VISIBLE, state));
    this._indicator.menu.addMenuItem(this._visibleItem);

    this._collapsedItem = new PopupMenu.PopupSwitchMenuItem('Auto-hide (click per espandere)', this._settings.get_boolean(KEY_COLLAPSED));
    this._collapsedItem.connect('toggled', (item, state) => { this._settings.set_boolean(KEY_COLLAPSED, state); state ? (this._expanded = true, this._collapseWidget()) : (this._expanded = false, this._expandWidget()); });
    this._indicator.menu.addMenuItem(this._collapsedItem);

    this._settings.set_strv('toggle-shortcut', this._settings.get_strv('toggle-shortcut'));
    Main.wm.addKeybinding('toggle-shortcut', this._settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL, () => { const currentCollapsed = this._settings.get_boolean(KEY_COLLAPSED); if (currentCollapsed) { this._expanded ? this._collapseWidget() : this._expandWidget(); } else { this._settings.set_boolean(KEY_COLLAPSED, true); this._expanded = true; this._collapseWidget(); } });

    this._editItem = new PopupMenu.PopupSwitchMenuItem('Edit mode (drag/resize)', this._settings.get_boolean(KEY_EDIT));
    this._editItem.connect('toggled', (item, state) => this._settings.set_boolean(KEY_EDIT, state));
    this._indicator.menu.addMenuItem(this._editItem);

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    this._editChangedId = this._settings.connect(`changed::${KEY_EDIT}`, () => { const state = this._settings.get_boolean(KEY_EDIT); this._editItem.setToggleState(state); this._applyEditMode(state); });
    this._visibleChangedId = this._settings.connect(`changed::${KEY_VISIBLE}`, () => { const state = this._settings.get_boolean(KEY_VISIBLE); this._visibleItem.setToggleState(state); this._applyVisibility(state); });
    this._collapsedChangedId = this._settings.connect(`changed::${KEY_COLLAPSED}`, () => { const state = this._settings.get_boolean(KEY_COLLAPSED); this._collapsedItem.setToggleState(state); });

    Main.wm.addKeybinding('toggle-edit-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._settings.set_boolean(KEY_EDIT, !this._settings.get_boolean(KEY_EDIT)));
    Main.wm.addKeybinding('toggle-visible-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._settings.set_boolean(KEY_VISIBLE, !this._settings.get_boolean(KEY_VISIBLE)));

    this._applyEditMode(this._settings.get_boolean(KEY_EDIT));
    const isVisible = this._settings.get_boolean(KEY_VISIBLE);
    this._box.visible = isVisible;
    this._box.opacity = isVisible ? 255 : 0;
    if (this._settings.get_boolean(KEY_COLLAPSED)) { this._box.set_height(this._collapsedHeight); this._list.visible = false; this._bottomBar.visible = false; this._scrollView.visible = false; this._scrollView.reactive = false; this._searchEntry.visible = false; this._expanded = false; this._applyCollapsedState(true); }
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this._applyVisibility(this._settings.get_boolean(KEY_VISIBLE)); return GLib.SOURCE_REMOVE; });

    this._refresh();
    this._monitor = this._currentDir.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null);
    this._monitorChangedId = this._monitor.connect('changed', () => this._refresh());
  }

  disable() {
    Main.wm.removeKeybinding('toggle-edit-shortcut');
    Main.wm.removeKeybinding('toggle-visible-shortcut');
    Main.wm.removeKeybinding('toggle-shortcut');
    this._menuOpen = false;
    if (this._editChangedId && this._settings) this._settings.disconnect(this._editChangedId);
    if (this._visibleChangedId && this._settings) this._settings.disconnect(this._visibleChangedId);
    if (this._collapsedChangedId && this._settings) this._settings.disconnect(this._collapsedChangedId);
    if (this._monitorChangedId && this._monitor) { this._monitor.disconnect(this._monitorChangedId); }
    if (this._focusWindowChangedId) global.display.disconnect(this._focusWindowChangedId);
    this._monitor?.cancel();
    if (this._openBtnPressId) this._openBtn?.disconnect(this._openBtnPressId);
    if (this._stageClickId) global.stage.disconnect(this._stageClickId);
    if (this._titlePressId) this._titleBar?.disconnect(this._titlePressId);
    if (this._handlePressId) this._resizeHandle?.disconnect(this._handlePressId);
    if (this._motionId) global.stage.disconnect(this._motionId);
    if (this._releaseId) global.stage.disconnect(this._releaseId);
    if (this._currentContextMenu) { this._currentContextMenu.close(false); this._currentContextMenu.destroy(); this._currentContextMenu = null; }
    if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
    if (this._box) { Main.layoutManager.removeChrome(this._box); this._box.destroy(); this._box = null; }
    this._homeBtn = null; this._backBtn = null; this._openBtn = null; this._titleLabel = null; this._titleBar = null; this._searchEntry = null; this._scrollView = null; this._list = null; this._resizeHandle = null; this._bottomBar = null; this._collapsedItem = null; this._currentDir = null; this._dirStack = null; this._settings = null;
  }

  _openUri(uri) { try { Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1)); } catch (e) { logError(e, `Failed to open URI: ${uri}`); } }
  _applyEditMode(enabled) { if (!this._box) return; this._titleBar.reactive = enabled; this._resizeHandle.visible = enabled; this._box.reactive = true; this._box.can_focus = enabled; this._box.track_hover = true; }
  _applyVisibility(visible) { if (!this._box) return; this._box.remove_all_transitions(); if (visible) { this._box.opacity = 0; this._box.visible = true; this._box.ease({ opacity: 255, duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); } else { this._box.ease({ opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => { this._box.visible = false; if (this._settings.get_boolean(KEY_EDIT)) this._settings.set_boolean(KEY_EDIT, false); } }); } }
  _applyCollapsedState(collapsed) {
    if (!this._box) return;
    if (collapsed) {
      Main.layoutManager.removeChrome(this._box);
      Main.layoutManager.addChrome(this._box, { affectsStruts: false, trackFullscreen: false });
      this._titleLabel.visible = false; this._searchEntry.visible = false; this._backBtn.visible = false; this._homeBtn.visible = false;
      this._titleBar.set_style('margin-bottom: 0; justify-content: center;');
      const spacer = this._titleBar.get_child_at_index(3); if (spacer) spacer.visible = false;
      this._openIcon.icon_name = 'user-desktop-symbolic'; this._openIcon.set_style('icon-size: 24px; color: #83a598;');
      this._openBtn.set_style(`padding: 10px; border-radius: 999px; background-color: rgba(0,0,0,0.01); border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 2px 4px rgba(0,0,0,0.2);`);
      this._titleBar.reactive = false; this._list.reactive = false; this._searchEntry.reactive = false; this._box.reactive = false; this._openBtn.reactive = true;
      this._box.set_style('padding: 0px; background-color: transparent; border: none; box-shadow: none;');
      this._box.set_height(48); this._box.set_width(48);
    } else {
      Main.layoutManager.removeChrome(this._box);
      Main.layoutManager.addChrome(this._box, { affectsStruts: false, trackFullscreen: false });
      this._titleLabel.visible = true; this._searchEntry.visible = true; this._backBtn.visible = this._dirStack.length > 0; this._homeBtn.visible = this._dirStack.length > 0; this._scrollView.visible = true; this._scrollView.reactive = true; this._titleBar.set_style('margin-bottom: 6px;');
      const spacer = this._titleBar.get_child_at_index(3); if (spacer) spacer.visible = true;
      this._openIcon.icon_name = 'folder-open-symbolic'; this._openIcon.set_style('icon-size: 14px; color: #83a598;'); this._openBtn.set_style('padding: 3px; border-radius: 6px; background-color: rgba(255,255,255,0.10);');
      this._titleBar.reactive = true; this._list.reactive = true; this._searchEntry.reactive = true; this._box.reactive = true; this._openBtn.reactive = true;
      this._box.set_width(this._settings.get_int('w')); this._box.set_height(-1); this._box.set_style(`padding: 12px; border-radius: 12px; background-color: rgba(0,0,0,0.60); color: #fff; border: 1px solid rgba(255,255,255,0.12);`);
    }
  }
  _expandWidget() { if (this._expanded || !this._box) return; this._expanded = true; this._applyCollapsedState(false); this._list.visible = true; this._bottomBar.visible = true; const targetHeight = this._settings.get_int('h'); this._box.remove_all_transitions(); this._box.ease({ height: targetHeight, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); }
  _collapseWidget() { if (!this._expanded || !this._box) return; this._expanded = false; this._applyCollapsedState(true); this._box.remove_all_transitions(); this._box.ease({ height: this._collapsedHeight, duration: 150, mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => { this._list.visible = false; this._bottomBar.visible = false; this._scrollView.visible = false; this._scrollView.reactive = false; } }); }
  _navigateInto(dir) { this._dirStack.push(this._currentDir); this._currentDir = dir; if (this._monitor) { this._monitor.cancel(); this._monitor = null; } this._monitor = this._currentDir.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null); if (this._monitorChangedId) this._monitor.disconnect(this._monitorChangedId); this._monitorChangedId = this._monitor.connect('changed', () => this._refresh()); this._updateBreadcrumb(); this._refresh(); }
  _navigateBack() { if (this._dirStack.length === 0) return; this._currentDir = this._dirStack.pop(); if (this._monitor) { this._monitor.cancel(); this._monitor = null; } this._monitor = this._currentDir.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null); if (this._monitorChangedId) this._monitor.disconnect(this._monitorChangedId); this._monitorChangedId = this._monitor.connect('changed', () => this._refresh()); this._updateBreadcrumb(); this._refresh(); }
  _navigateHome() { this._dirStack = []; this._currentDir = Gio.File.new_for_path(GLib.get_home_dir()); if (this._monitor) { this._monitor.cancel(); this._monitor = null; } this._monitor = this._currentDir.monitor(Gio.FileMonitorFlags.WATCH_MOVES, null); if (this._monitorChangedId) this._monitor.disconnect(this._monitorChangedId); this._monitorChangedId = this._monitor.connect('changed', () => this._refresh()); this._updateBreadcrumb(); this._refresh(); }
  _updateBreadcrumb() { const homePath = GLib.get_home_dir(); const currentPath = this._currentDir.get_path(); this._titleLabel.text = currentPath === homePath ? 'Home' : GLib.path_get_basename(currentPath); this._backBtn.visible = this._dirStack.length > 0; this._homeBtn.visible = this._dirStack.length > 0; this._scrollView.visible = true; this._scrollView.reactive = true; }
  _showContextMenu(sourceActor, filePath, fileName, isDir) { if (this._currentContextMenu) { this._currentContextMenu.close(false); this._currentContextMenu.destroy(); this._currentContextMenu = null; } this._menuOpen = true; const menu = new PopupMenu.PopupMenu(sourceActor, 0.0, St.Side.TOP); this._currentContextMenu = menu; Main.uiGroup.add_child(menu.actor); menu.actor.hide(); menu.addAction('Apri', () => this._openUri(Gio.File.new_for_path(filePath).get_uri())); menu.addAction('Mostra in Files', () => this._openUri(Gio.File.new_for_path(GLib.path_get_dirname(filePath)).get_uri())); menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem()); menu.addAction('Copia percorso', () => { const clipboard = St.Clipboard.get_default(); clipboard.set_text(St.ClipboardType.CLIPBOARD, filePath); }); menu.addAction('Rinomina...', () => this._openUri(Gio.File.new_for_path(GLib.path_get_dirname(filePath)).get_uri())); menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem()); menu.addAction('Sposta nel cestino', () => { try { Gio.File.new_for_path(filePath).trash(null); this._refresh(); } catch (e) { logError(e, `Failed to trash: ${fileName}`); } }); menu.open(true); const closeId = menu.connect('open-state-changed', (menu, open) => { if (!open) { menu.disconnect(closeId); menu.destroy(); if (this._currentContextMenu === menu) this._currentContextMenu = null; this._menuOpen = false; } }); }
  _refresh() { if (!this._list) return; this._list.destroy_all_children(); try { const enumerator = this._currentDir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null); const items = []; let info; const searchText = this._settings.get_string('search-text').toLowerCase(); while ((info = enumerator.next_file(null)) !== null) { const name = info.get_name(); if (name.startsWith('.')) continue; if (searchText && !name.toLowerCase().includes(searchText)) continue; const isDir = info.get_file_type() === Gio.FileType.DIRECTORY; const fullPath = GLib.build_filenamev([this._currentDir.get_path(), name]); items.push({ name, path: fullPath, isDir }); } items.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)); for (const it of items) { const btn = new St.Button({ style_class: 'desktop-file-button', x_align: Clutter.ActorAlign.START, style: 'padding: 2px 4px; border-radius: 4px; background-color: transparent;' }); const itemBox = new St.BoxLayout({ vertical: false, style: 'spacing: 6px;' }); itemBox.add_child(new St.Icon({ icon_name: it.isDir ? 'folder-symbolic' : 'text-x-generic-symbolic', icon_size: 16, style: `color: ${it.isDir ? '#83a598' : '#d3869b'};` })); itemBox.add_child(new St.Label({ text: it.name, style: 'padding: 0;', y_align: Clutter.ActorAlign.CENTER })); btn.set_child(itemBox); btn.connect('enter-event', () => btn.set_style('padding: 2px 4px; border-radius: 4px; background-color: rgba(255,255,255,0.15);')); btn.connect('leave-event', () => btn.set_style('padding: 2px 4px; border-radius: 4px; background-color: transparent;')); btn.connect('clicked', () => { const file = Gio.File.new_for_path(it.path); it.isDir ? this._navigateInto(file) : this._openUri(file.get_uri()); }); btn.connect('button-press-event', (actor, event) => event.get_button() === 3 ? (this._showContextMenu(btn, it.path, it.name, it.isDir), Clutter.EVENT_STOP) : Clutter.EVENT_PROPAGATE); this._list.add_child(btn); } if (items.length === 0 && searchText) this._list.add_child(new St.Label({ text: 'Nessun risultato', style: 'font-style: italic; opacity: 0.6;' })); } catch (e) { this._list.add_child(new St.Label({ text: `Errore: ${e.message}` })); } }
}
