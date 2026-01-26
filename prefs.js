import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class Prefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings('org.gnome.shell.extensions.desktop-folder-widget');

    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      margin_top: 18, margin_bottom: 18,
      margin_start: 18, margin_end: 18,
      spacing: 12,
    });

    const sw = new Gtk.Switch({ active: settings.get_boolean('edit-mode') });
    sw.connect('notify::active', () => settings.set_boolean('edit-mode', sw.active));

    box.append(new Gtk.Label({ label: 'Edit mode (drag/resize)', xalign: 0 }));
    box.append(sw);

    window.add(box);
  }
}
