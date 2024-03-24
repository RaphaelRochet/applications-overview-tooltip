import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Search from 'resource:///org/gnome/shell/ui/search.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';
import {Extension, gettext as _, ngettext as __} from 'resource:///org/gnome/shell/extensions/extension.js';

// options
let LABELSHOWTIME	= 15/100;
let LABELHIDETIME 	= 10/100;
let SLIDETIME		= 15/100;
let HOVERDELAY		= 300;
let TITLE			= true;
let APPDESCRIPTION	= true;
let GROUPAPPCOUNT	= true;
let BORDERS			= false;
let KEYBOARD		= true;

export default class ApplicationOverviewTooltipExtension extends Extension {

	constructor(metadata) {
		super(metadata);
	}

	enable() {
		// Some default values for private variables
		this._old_addItem = null;		// used to restore monkey patched function on disable
		this._old_searchAddItem = null;	// same but for search results
		this._labelTimeoutId = 0;		// id of timer waiting for start
		this._resetHoverTimeoutId = 0;	// id of last (cancellable) timer
		this._ttbox = null;				// actor for displaying the tooltip
		this._ttlayout = null;
		this._ttlabel = null;			// tooltip label
		this._ttdetail = null;			// tooltip description label
		this._labelShowing = false;		// self explainatory
		// Load settings
		this._settings = this.getSettings();
		this._settingsConnectionId = this._settings.connect('changed', this._applySettings.bind(this));
		this._applySettings();
		// Memorize all connections to events to remove them later if needed
		this._tooltips = new Array();
		// Enabling tooltips for already loaded icons
		this._connectAll(Main.overview._overview._controls._appDisplay);
		// Hide tooltip when overview is hidden
		this._ovHidingConnectionId = Main.overview.connect('hiding', this._onLeave.bind(this));
		// monkypatching icon views to be able to link on future icons
		let that = this;
		// ... in app icons view
		this._old_addItem = IconGrid.IconGrid.prototype.addItem;
		IconGrid.IconGrid.prototype.addItem = function(item, page, index){
			that._connect(item); // connect to new icon
			that._old_addItem.apply(this, arguments); // then call original function
		};
		// ... in search results
		this._old_searchAddItem = Search.GridSearchResults.prototype._addItem;
		Search.GridSearchResults.prototype._addItem = function(display){
			that._connect(display);
			that._old_searchAddItem.apply(this, arguments);
		};
	}

	disable() {
		// restore the original addItem functions and remove our references to them
		IconGrid.IconGrid.prototype.addItem = this._old_addItem;
		Search.GridSearchResults.prototype._addItem = this._old_searchAddItem;
		this._old_addItem = null;
		this._old_searchAddItem = null;
		// Be sure to remove any timeout still active
		if (this._labelTimeoutId > 0){
			GLib.Source.remove(this._labelTimeoutId);
			this._labelTimeoutId = 0;
		}
		// Disconnect from all events
		if (this._settingsConnectionId > 0) this._settings.disconnect(this._settingsConnectionId);
		this._settings = null;
		if (this._ovhidingConnectionId > 0) Main.overview.disconnect(this._ovHidingConnectionId);
		// disconnects from all loaded icons
		for (let i = 0; i < this._tooltips.length; i++) {
			this._tooltips[i].actor.disconnect(this._tooltips[i].con_d);
			this._tooltips[i].actor.disconnect(this._tooltips[i].con_h);
			this._tooltips[i].actor.disconnect(this._tooltips[i].con_focus_in);
			this._tooltips[i].actor.disconnect(this._tooltips[i].con_focus_out);
		}
		this._tooltips=null;
		this._ttbox = null;
		this._ttlayout = null;
		this._ttlabel = null;
		this._ttdetail = null;
	}

	_applySettings() {
		LABELSHOWTIME = this._settings.get_int("labelshowtime")/100 ;
		LABELHIDETIME = this._settings.get_int("labelhidetime")/100 ;
		HOVERDELAY = this._settings.get_int("hoverdelay") ;
		TITLE = this._settings.get_boolean("title") ;
		APPDESCRIPTION = this._settings.get_boolean("appdescription") ;
		GROUPAPPCOUNT = this._settings.get_boolean("groupappcount") ;
		BORDERS = this._settings.get_boolean("borders");
		KEYBOARD = this._settings.get_boolean("keyboard");
	}

	// Tooltip manipulation

	_showTooltip(actor) {
		// check if actor is still relevant, it may have been destroyed
		// between hover event and tooltip display (there's a small delay)
		// Skipping this test may lead to segfault
		if (! this._tooltips.find( (item) => (item.actor === actor) )) {
			return;
		}
		let icontext = '';
		let titletext = '';
		let detailtext = '';
		let should_display = false;
		if (actor._delegate.app){
			//applications overview
			icontext = actor._delegate.app.get_name();
			if (APPDESCRIPTION) {
				let appDescription = actor._delegate.app.get_description();
				if (appDescription){
					detailtext = appDescription;
					should_display = true;
				}
			}
		} else if (actor._delegate.hasOwnProperty('_folder')){
			// folder in the application overview
			icontext = actor._delegate['name'];
			if (GROUPAPPCOUNT) {
				let appCount = actor._delegate.view.getAllItems().length;
				detailtext = __( "Group of %d application", "Group of %d applications", appCount ).format(appCount);
				should_display = true;
			}
		} else {
			//app and settings searchs results
			icontext = actor._delegate.metaInfo['name'];
		}
		// Decide wether to show title
		if ( TITLE && icontext ) {
			titletext = icontext;
			should_display = true;
		}
		// If there's something to show ..
		if ( ( titletext || detailtext ) && should_display ) {
			// Create a new tooltip if needed
			if (!this._ttbox) {
				let css_class = BORDERS ? 'app-tooltip-borders' : 'app-tooltip';
				this._ttbox = new St.Bin({ style_class: css_class });
				this._ttlayout = new St.BoxLayout({ vertical: true });
				this._ttlabel = new St.Label({ style_class: 'app-tooltip-title', text: titletext });
				this._ttdetail = new St.Label({ style_class: 'app-tooltip-detail', text: detailtext });
				this._ttlayout.add_child(this._ttlabel);
				this._ttlayout.add_child(this._ttdetail);
				this._ttbox.add_child(this._ttlayout);
				// we force text wrap on both labels
				this._ttlabel.clutter_text.line_wrap = true;
				this._ttlabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
				this._ttlabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
				this._ttdetail.clutter_text.line_wrap = true;
				this._ttdetail.clutter_text.line_wrap_mode = Pango.WrapMode.WORD;
				this._ttdetail.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
				// Add as a new child on screen
				Main.uiGroup.add_child(this._ttbox);
			} else {
				this._ttlabel.text = titletext;
				this._ttdetail.text = detailtext;
			}
			// Show/Hide elements as needed
			if (!titletext) { this._ttlabel.hide() } else { this._ttlabel.show() };
			if (!detailtext) { this._ttdetail.hide() } else { this._ttdetail.show() };
			// Compute tooltip location
			let [stageX, stageY] = actor.get_transformed_position();
			let [iconWidth, iconHeight] = actor.get_transformed_size();
			let y = stageY + iconHeight + 5;
			let x = stageX - Math.round((this._ttbox.get_width() - iconWidth)/2);
			// do not show label move if not in showing mode
			if (this._labelShowing) {
				this._ttbox.ease({
					x: x,
					y: y,
					opacity: 255,
					duration: SLIDETIME  * 100,
					mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				});
			} else {
				this._ttbox.set_position(x, y);
				this._ttbox.ease({
					x: x,
					y: y,
					opacity: 255,
					duration: LABELSHOWTIME  * 100,
					mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				});
				this._labelShowing = true;
			}
		} else {
			// No tooltip to show : act like we're leaving an icon
			this._onLeave();
		}
	}

	_hideTooltip() {
		if (this._ttbox){
			this._ttbox.ease({
				opacity: 0,
				duration: LABELHIDETIME  * 100,
				mode: Clutter.AnimationMode.EASE_OUT_QUAD,
				onComplete: () => {
					this._ttlabel = null;
					this._ttdetail = null;
					Main.uiGroup.remove_child(this._ttbox);
					this._ttbox = null;
				}
			});
		}
	}

	// Events related to app icons

	_connectAll(view) {
		let appIcons = view._orderedItems;
		for (let i in appIcons) {
			let icon = appIcons[i];
			let actor = icon;
			if (actor._delegate.hasOwnProperty('_folder')) {
				this._connectAll(icon.view)
			}
			this._connect(actor);
		}
	}
	_connect(actor) {
		this._tooltips.push({
			'actor': actor,
			'con_focus_in': actor.connect('key-focus-in', this._onHover.bind(this)),
			'con_focus_out': actor.connect('key-focus-out', this._onHover.bind(this)),
			'con_h': actor.connect('notify::hover', this._onHover.bind(this)),
			'con_d': actor.connect('destroy', this._onDestroy.bind(this))
		});
	}
	_onHover(actor) {
		// checks if cursor is over the icon
		if (actor.get_hover() || ( KEYBOARD && actor.has_key_focus() )) {
			// it is : let's setup a toolip display
			// unless it's already set
			if (this._labelTimeoutId == 0) {
				// if the tooltip is already displayed (on another icon)
				// we update it, else we delay it
				if (this._labelShowing) {
					this._showTooltip(actor);
				} else {
					let that = this;
					this._labelTimeoutId = GLib.timeout_add(
						GLib.PRIORITY_DEFAULT,
						HOVERDELAY,
						function() {
							that._showTooltip(actor);
							that._labelTimeoutId = 0;
							return false;
						}
					);
				}
			}
		} else {
			// cursor is no more on an icon
			this._onLeave();
		}
	}
	_onLeave() {
		// unset label display timer if needed
		if (this._labelTimeoutId > 0){
			GLib.Source.remove(this._labelTimeoutId);
			this._labelTimeoutId = 0;
		}
		if (this._labelShowing) {
			this._hideTooltip();
			this._labelShowing = false;
		}
	}
	_onDestroy(actor) {
		// This AppIcon is being destroy, let's forget about it
		// so we don't try to disconnect from it later
		this._tooltips = this._tooltips.filter( (item) => (item.actor !== actor) );
	}

}
