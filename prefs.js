import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class Prefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings('org.gnome.shell.extensions.desktop-folder-widget');

    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
      title: 'Impostazioni Widget',
      description: 'Configura il comportamento del widget',
    });

    // Switch visibilità widget
    const visibleRow = new Adw.ActionRow({
      title: 'Mostra widget',
      subtitle: 'Visualizza o nascondi il widget sul desktop',
    });
    const visibleSwitch = new Gtk.Switch({
      active: settings.get_boolean('visible'),
      valign: Gtk.Align.CENTER,
    });
    visibleSwitch.connect('notify::active', () => {
      settings.set_boolean('visible', visibleSwitch.active);
    });
    visibleRow.add_suffix(visibleSwitch);
    visibleRow.activatable_widget = visibleSwitch;

    // Switch auto-hide (collapsed)
    const collapsedRow = new Adw.ActionRow({
      title: 'Auto-hide',
      subtitle: 'Il widget si riduce a icona quando non in uso',
    });
    const collapsedSwitch = new Gtk.Switch({
      active: settings.get_boolean('collapsed'),
      valign: Gtk.Align.CENTER,
    });
    collapsedSwitch.connect('notify::active', () => {
      settings.set_boolean('collapsed', collapsedSwitch.active);
    });
    collapsedRow.add_suffix(collapsedSwitch);
    collapsedRow.activatable_widget = collapsedSwitch;

    // Switch edit mode
    const editRow = new Adw.ActionRow({
      title: 'Edit mode',
      subtitle: 'Abilita drag & resize del widget',
    });
    const editSwitch = new Gtk.Switch({
      active: settings.get_boolean('edit-mode'),
      valign: Gtk.Align.CENTER,
    });
    editSwitch.connect('notify::active', () => {
      settings.set_boolean('edit-mode', editSwitch.active);
    });
    editRow.add_suffix(editSwitch);
    editRow.activatable_widget = editSwitch;

    // Aggiungi tutto
    group.add(visibleRow);
    group.add(collapsedRow);
    group.add(editRow);
    page.add(group);
    window.add(page);
  }
}
