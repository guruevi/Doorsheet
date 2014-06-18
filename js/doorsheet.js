/**
 * Doorsheet.js
 * @author vanooste
 * @version 0.8a
 * @license GPLv3
 */
var debug = false;
var version = "0.8a";

/** Dev Notes: 
 * To check whether something is empty use $.isEmptyObject which works similar to how PHP's empty() works http://jsfiddle.net/ivan_sim/N8TVV/13/ except it doesn't work on arrays
 * Do async stuff first in line, then while that is running, something else can run
 * Make sure to instantiate local variables using var
 */

/**
 * This is our error handler
 */
window.onerror = function(msg, url, line) {
	//Let's hope the error sits not in print_error
	print_error("Fatal Error - things have broken, reload the Doorsheet to continue: " + msg + "\nurl: " + url + "\nline #: " + line);

	// TODO: Email the details of the errors or something, not sure what to do

	// If you return true, then IE-style error alerts will be suppressed.
	return false;
};

//Check whether we support Web Storage functions - Doorsheet doesn't work without it.
if (typeof (Storage) == "undefined") {
	// Sorry! No Web Storage support..
	alert("This browser does not support Local Web Storage, things won't work!");
}

//JavaScript does not have an Object storage method. Only string. So stringify using JSON
/**
 * Define setObject method on the Storage prototype
 */
Storage.prototype.setObject = function (key, value) {
	this.setItem(key, JSON.stringify(value));
};
/**
 * Define getObject method on Storage prototype
 */
Storage.prototype.getObject = function (key) {
	var value = this.getItem(key);
	return value && JSON.parse(value);
};

//Always make sure to clean up old data in debug mode or if the versions changed
var last_version = localStorage.getItem("version");
if (last_version != version || debug) {
	//The versions changed, clear the storage
	localStorage.clear();
	//Store the new version number
	localStorage.setItem("version", version);
}

/**
 * A very fast (and safe) clear function
 * pop is faster than setting length to 0 or 
 * creating a new array (whodathunk)
 */
Array.prototype.clear = function() {
	while (this.length > 0) {
		this.pop();
	}
};

/**
 * Ajax activity indicator bound to ajax start/stop document events
 */
$(document).ajaxStart(function(){ 
	$('#top-navbar').addClass("inprogress"); 
}).ajaxStop(function(){ 
	$('#top-navbar').removeClass("inprogress");
});

//Global variables
/**
 *  What is the Base URL for our source data - you can use a full URL here
 * TODO: Make this dynamically update-able in a config screen
 */
var BaseURL = "/";
/**
 * Where do we go to get our data
 * Add debug=1& to the URL for debugging purposes
 * Sequential=1 returns an array instead of an object of the results which makes things easier to parse using JavaScript array methods
 * TODO: Make this dynamically update-able in a config screen
 */
var CRMRESTURL = BaseURL + "sites/all/modules/civicrm/extern/rest.php?json=1&sequential=1&key=your-site-key&options[limit]=1000";
/**
 * Save the original URL so we can reset it in case we logout
 */
var CRMRESTURLorig = CRMRESTURL;
/**
 * Save the start time of this script
 */
var runStartTime = $.now();
/**
 * Cache data for 12 hours
 * TODO: Make this dynamically update-able in a config screen
 */
var cacheTime = 43200000;
/**
 * Get the last time this script ran
 */
var lastrun = parseInt(localStorage.getItem("lastrun"));
/**
 * Delay (in ms) between launching multiple Ajax requests
 */
var ajaxdelay = 100;
//TODO: Show in UI when we last refreshed
//TODO: Show in UI when we last ran this app

/**
 * Set the ID of the price field collection in the database 
 * TODO: Make these dynamically selectable using a config or whatever
 * WARNING: HARDCODED - If we change the price field sets in the database, this has to be changed.
 */
var membershipPriceFieldId = 7;
/**
 * This is the ID of the Trial/New Membership, this is grayed out for existing members and the rest is grayed out for non-members
 */
var trialMembershipId = 6;
/**
 * This is the ID of the Board Membership, this is to show additional options to board members
 */
var boardMembershipId = 1;
/**
 * Stores the logged in user object
 */
var LoggedInUser = null;
/**
 * Stores the logged in users' membership objects
 */
var LoggedInMemberships = null;

/**
 * Current Contact is the one that has been searched in the list
 */
var currentContact = null;
/**
 * Current Contacts' membership
 */
var currentContactMembership = null;
/**
 * Staged Transactions (in the transaction overview but not yet processed)
 */
var StagedTransactions = new StagedTransactions();

/**
 * This is the pop up progressbar object. Can be called anywhere, it's just UI 
 */
var progressBar = new ProgressBar();

/**
 * The Caches are all in a single object which can be referred to easily
 */
var Caches = {};

Caches.contacts = new Cache ("Contact");
Caches.memberships = new Cache ("Membership");
Caches.participantpayments = new Cache ("ParticipantPayment");
Caches.membershiptypes = new Cache ("MembershipType");
Caches.contributions = new Cache ("Contribution");
Caches.participants = new Cache ("Participant");

//Events are relatively static and may be cached locally
Caches.events = new Cache ("Event");
Caches.events.restore();
//Price sets are relatively static and may be cached locally
Caches.pricesets = new Cache ("PriceSet");
Caches.pricesets.restore();
//Price sets are relatively static and may be cached locally
Caches.pricefields = new Cache ("PriceField");
Caches.pricefields.restore();
//Price field values are relatively static and may be cached locally
Caches.pricefieldvalues = new Cache ("PriceFieldValue");
Caches.pricefieldvalues.restore();

/**
 * This stores all the event panel objects
 */
var EventPanels = {};

/**
 * Set the preferred theme
 */
var currentTheme = localStorage.getItem("doorsheet-theme");
if (currentTheme != null && currentTheme.length > 0) {
	setTheme (currentTheme);
}

/**
 * Get the user_api_key stored in localStorage
 */
var user_api_key = localStorage.getItem("user_api_key");
/**
 * Get the user login stored in localStorage
 */
var user_login = localStorage.getItem("user_login");

if (!user_api_key || user_api_key.length != 32) {
	$("#login-modal").modal('show'); //Open Login Modal on start
} else {
	login_user(user_login, user_api_key);
}

//Get the past transactions out
$("#transactions-table tbody").append(localStorage.getObject("TxInfo"));

/**
 * A generic Cache object
 * Querying this object may return an empty variable or even an undefined
 */
function Cache(entity) {
	var context = this;
	this.entity = entity;
	this.data = []; //Use an array of objects for easier sorts

	function master_addItem (data) {
		if (typeof data == "undefined" || data == null) {
			return context;
		}
		if (!"id" in data || data.id == null) {
			print_error("BUG: Attempting to add data without ID to the cache");
			return context;
		}
		if (typeof context.data[data.id] == "undefined") {
			context.data[data.id] = {};
		}
		for (var attr in data) {
			if (data.hasOwnProperty(attr)) {
				context.data[data.id][attr] = data[attr];
			}
		}
		return context;
	}

	function master_restore() {
		print_debug ("Restoring " + context.entity + " data from localStorage");
		var obj = localStorage.getObject(context.entity+"Cache");
		if (obj == null) {
			context.data.clear();
			//Do not fetch here
		} else {
			context.setData(obj);
		}
		context.lastfetch = lastrun; //This data may be stale, make sure we can re-fetch
		return context;
	};

	this.setData = function (object) {
		for (var key in object) {
			if(object.hasOwnProperty(key)){
				if (typeof object[key] == "undefined" || object[key] == null) {
					continue;
				}
				context.addItem(object[key]);
			}
		}
		return context; //Make things chainable
	};

	this.addItem = function (data) {
		return master_addItem(data);
	};

	this.remove = function (id) {
		//Return true/false whether the deletion worked
		print_debug ("Removing data from "+context.entity+" Cache");
		return (delete context.data[id]);
	};

	this.save = function () {
		print_debug ("Writing "+context.entity+" data to localStorage");
		localStorage.setObject(context.entity+"Cache", context.data);
		return context;
	};

	this.empty = function () {
		print_debug ("Emptying "+context.entity+" data and removing from localStorage");
		context.data.clear();
		context.lastfetch = 0;
		return localStorage.removeItem(context.entity+"Cache");
	};

	this.lastfetch = $.now();

	this.fetch = function (success_callback, fail_callback, always_callback) {
		//At least wait 5 minutes before re-fetching - 5 min = 300000 milliseconds
		if ((context.data.length > 0) && ((context.lastfetch + 300000) > $.now())) {
			if (typeof success_callback == "function") {
				success_callback.call();
			}
			if (typeof always_callback == "function") {
				always_callback.call();
			}
			return;
		}
		var query = {};
		query.entity = context.entity;
		query.action = "get";
		if (context.entity == "Contact") {
			query['return'] = "nick_name,sort_name,first_name,last_name,email,custom_1,custom_2,custom_3,custom_4,custom_5";
		}
		$.ajax({
			url: CRMRESTURL,
			dataType: "json", //Don't forget to say this, it will fail otherwise
			data: query
		})
		.done(function (ret_data, textStatus, jqXHR) {
			if (!test_apidata_error(ret_data, "Successfully retrieved " + context.entity, "Error retrieving " + context.entity)) {
				if (typeof fail_callback == "function") {
					fail_callback.call();
				}
				var retry = $("<a href='#'>Retry loading the data</a>");
				retry.click(function () {
					$(this).remove();
					context.fetch(success_callback, fail_callback, always_callback);
				});
				$("#error").append(retry).append("<br>");
				return false;
			}
			context.lastfetch = $.now();
			context.empty();
			context.setData(ret_data.values);
			context.save();
			if (typeof success_callback == "function") {
				success_callback.call();
			}
		})
		.fail(function (jqXHR, textStatus, errorThrown) {
			print_error("There was an error loading " + context.entity);
			var retry = $("<a href='#'>Retry loading the data</a>");
			retry.click(function () {
				$(this).remove();
				context.fetch(success_callback, fail_callback, always_callback);
			});
			$("#error").append(retry).append("<br>");

			if (typeof fail_callback == "function") {
				fail_callback.call();
			}
		})
		.always(function () {
			if (typeof always_callback == "function") {
				always_callback.call();
			}
			progressBar.update(10);
		});
		return context;
	};

	//We can overwrite this function and call master_restore from the re-written function if necessary
	this.restore = function () {
		return master_restore();
	};

	this.getLast = function (contact_id, limit, sortfield, filterfield, filtervalue) {
		if (typeof sortfield == 'undefined') {
			sortfield = "id";
		}
		var filtered = context.getContactId(contact_id);

		if (typeof filterfield != 'undefined') {
			filtered = filtered.filter(function (value) {
				return value[filterfield] == filtervalue;
			});
		}

		var sorted = filtered.sort(function (a, b) {
			//We typically want to sort from large to small
			if (a[sortfield] < b[sortfield])
				return 1;
			if (a[sortfield] > b[sortfield])
				return -1;
			return 0;
		});
		return sorted.slice(0, limit);
	};

	this.getContactId = function (contact_id) {
		if (contact_id == null || parseInt(contact_id) == NaN) {
			print_error ("BUG: Contact ID not a valid number");
			return {};
		}
		contact_id = contact_id.toString(); //contact_id is a string in the API
		return context.data.filter(function (value) {
			if (typeof value == "undefined") {
				return false;
			}
			return (value.contact_id == contact_id);
		});
	};

	this.getEntity = function (entity_id) {
		print_error("Object does not have feature Entity");
	};

	this.getByNickName = function (nick_name) {
		print_error("Object does not have feature NickName");
	};

	this.getNickName = function (id) {
		print_error("Object does not have feature NickName");
	};

	this.getByEmail = function (email) {
		print_error("Object does not have feature Email");
	};

	if (entity == "Contact") {
		//Contacts need to be reloaded every time
		this.getByNickName = function (nick_name) {
			return context.data.filter(function (value) {
				if (typeof value == "undefined") {
					return false;
				}
				return (value.nick_name == nick_name);
			});
		};

		this.getNickName = function (id) {
			//Not all contacts have nick names
			var nick_name = context.data[id].nick_name;
			if (nick_name == "") {
				return context.data[id].sort_name;
			}
			return nick_name;
		};

		this.getByEmail = function (email) {
			return context.data.filter(function (value) {
				if (typeof value == "undefined") {
					return false;
				}
				return (value.email == email);
			});
		};

		//Overwrite with a simpler function
		this.getContactId = function (contact_id) {
			return context.data[contact_id];
		};

		this.addItem = function (contact) {
			if (typeof contact == "undefined" || contact == null) {
				return;
			}
			//Custom_1 = banned
			//Custom_2 = can bring guests
			//Custom_3 = credit 
			//Custom_4 = rbucks
			//custom_5 = guest passes
			if ("custom_1" in contact) {
				contact.banned = parseInt(contact.custom_1);
				if (isNaN(contact.banned) || contact.banned == 0) {
					contact.banned = false;
				} else {
					contact.banned = true;
				}
			}
			if ("custom_2" in contact) {
				contact.guests = parseInt(contact.custom_2);
				if (isNaN(contact.guests) || contact.guests > 0) {
					contact.guests = true;
				} else {
					contact.guests = false;
				}
			}
			if ("custom_3" in contact) {
				contact.credit = parseFloat(contact.custom_3);
				if (isNaN(contact.credit)) {
					contact.credit = 0;
				}
			}
			if ("custom_4" in contact) {
				contact.rbucks = parseInt(contact.custom_4);
				if (isNaN(contact.rbucks)) {
					contact.rbucks = 0;
				}
			}
			if ("custom_5" in contact) {
				contact.guestpasses = parseInt(contact.custom_5);
				if (isNaN(contact.guestpasses)) {
					contact.guestpasses = 0;
				}
			}

			return master_addItem(contact);
		};
	} else if (entity == "PriceSet") {
		//Make a custom getEntity field. Price Sets have entities they are connected to
		//This getEntity should match against civicrm_event
		this.getEntity = function (entity_id) {
			//Get the entity id which will be in string format
			entity_id = parseInt(entity_id).toString();

			//Filter the data out
			return context.data.filter(function (value) {

				//Don't check against the empty values
				if (typeof value == "undefined") {
					return false;
				}

				var found = false;

				//value.entity is an object of structure entity type => [array of entity ids]
				$.each (value.entity, function (entity_type, entity_ids) {
					if (entity_type == "civicrm_event" && entity_ids.indexOf(entity_id) != -1) {
						found = true;
						return false;
					}
				});
				return found;
			});
		};
	} else if (entity == "PriceField") {
		this.getEntity = function (entity_id) {
			//Get the PriceSets that the entity matches to
			var match_pricesets = Caches.pricesets.getEntity(entity_id);
			return context.data.filter(function (value) {
				if (typeof value == "undefined") {
					return false;
				}
				var found = false;
				$.each (match_pricesets, function (idx, priceset) {
					if (value.price_set_id == priceset.id) {
						found = true;
						return false;
					}
				});
				return found;
			});
		};
	} else if (entity == "PriceFieldValue") {
		this.getEntity = function (entity_id) {
			//Get the PriceField that the entity matches to
			var match_pricefields = Caches.pricefields.getEntity(entity_id);
			return context.data.filter(function (value) {
				if (typeof value == "undefined") {
					return false;
				}
				var found = false;
				$.each (match_pricefields, function (idx, pricefield) {
					if (value.price_field_id == pricefield.id) {
						found = true;
						return false;
					}
				});
				return found;
			});
		};
	}
	return this;
}

function setTheme (themename) {
	var link = $("#bootstrap-link");
	link.attr("href", "css/bootswatch/"+themename+"/bootstrap.min.css");
	localStorage.setItem("doorsheet-theme", themename);
}

$("a.style-toggle").click(function (e) {
	e.preventDefault();
	setTheme ($(this).data('themename'));
});

/**
 * Get all the participants for an event
 * @param event_id
 * @returns array[]
 */
function getParticipants_Event(event_id) {
	event_id = event_id.toString();
	return Caches.participants.data.filter(function (participant) {
		if (typeof participant == "undefined") {
			return false;
		}
		return participant.event_id == event_id;
	});
}

/**
 * Get all the participants entry for a contact
 * @param contact_id
 * @returns array[]
 */
function getParticipants_Contact(contact_id) {
	return Caches.participants.getContactId(contact_id);
}

/**
 * Find out if a contact is already participant in the event - if so, return it's ID
 * @param contact_id
 * @param event_id
 * @return Number 0 if not found or id
 */
function getParticipantId_Contact_Event(contact_id, event_id) {
	var event_participants = getParticipants_Event (event_id);
	var ret = 0;
	$.each (event_participants, function (i, participant) {
		if (participant.contact_id == contact_id) {
			ret = participant.id;
			return false;
		}
	});

	return ret;
}

/**
 * Get a particular contribution
 * @param contribution_id
 * @returns Object
 */
function getContribution (contribution_id) {
	return Caches.contributions.data[contribution_id];
}

/**
 * This function generates the end report
 */
function getReports() {
	if (Caches.events.data.length == 0 || Caches.participants.data.length == 0 || Caches.memberships.data.length == 0 || Caches.contributions.data.length == 0 || Caches.participantpayments.data.length == 0) {
		setTimeout(getReports, 250);
		return;
	}

	var loaded_events = $("#load-events-form input[name='event-id[]']:checked");
	if (loaded_events.length == 0) {
		print_error("You did not load any events, load an event");
		setTimeout(getReports, 250);
		return;
	}

	var uniq_contacts = [];
	var datesArr = [];
	//Call this as a filter
	function onlyUnique(value, index, self) { 
		return self.indexOf(value) === index;
	}

	var tbody = $("#event_report tbody");
	tbody.empty();
	var eventtotaltr = $("<tr>");
	var eventtotalcashtd = $("<td>");
	var eventtotalcredittd = $("<td>");
	var eventtotalchecktd = $("<td>");
	var eventtotalrbuckstd = $("<td>");
	var eventtotalparticipanttd = $("<td>");
	//Make a neat table for each event
	eventtotaltr.append("<td>Event totals</td>")
	.append(eventtotalcashtd)
	.append(eventtotalcredittd)
	.append(eventtotalchecktd)
	.append(eventtotalrbuckstd)
	.append(eventtotalparticipanttd);
	var eventtotalcheckContrib = 0;
	var eventtotalcashContrib = 0;
	var eventtotalcreditContrib = 0;
	var eventtotalrbucksContrib = 0;

	$.each(loaded_events, function (idx, event_input) {
		//For each loaded event
		var event = Caches.events.data[$(event_input).val()];
		datesArr.push(moment(event.start_date));
		datesArr.push(moment(event.end_date));
		var tr = $("<tr data-eventid="+event.id+">");
		var cashtd = $("<td>");
		var credittd = $("<td>");
		var checktd = $("<td>");
		var rbuckstd = $("<td>");
		var participanttd = $("<td>");
		//Make a neat table for each event
		tr.append("<td>"+event.title+"</td>")
		.append(cashtd)
		.append(credittd)
		.append(checktd)
		.append(rbuckstd)
		.append(participanttd);
		tbody.append(tr);
		//Initialize all the data to zero
		var checkContrib = 0;
		var cashContrib = 0;
		var creditContrib = 0;
		var rbucksContrib = 0;
		var eventguests = 0;
		//Get participants filtered by event_id
		var participants = getParticipants_Event(event.id);
		//Set the number of participants

		$.each (participants, function (idx, participant) {
			if (participant.participant_status_id != 2) {
				return true; //Return false breaks the entire loop, return non-false is a 'continue'
			}
			if (Caches.memberships.getContactId(participant.contact_id).length == 0) {
				eventguests++; //Participant does not have an associated membership, therefore they are guests
			}
			uniq_contacts.push(participant.contact_id);
			var participant_payments = getParticipantPayment_Participant(participant.id);
			$.each(participant_payments, function (idx, participant_payment) {
				var contribution = getContribution (participant_payment.contribution_id);
				if (contribution.instrument_id == "83") {
					cashContrib += parseFloat(contribution.total_amount);	
				} else if (contribution.instrument_id == "84") {
					checkContrib += parseFloat(contribution.total_amount);
				} else if (contribution.instrument_id == "81") {
					creditContrib += parseFloat(contribution.total_amount);
				} else if (contribution.instrument_id == "720") {
					rbucksContrib += parseInt(contribution.total_amount);
				}
			});
		});
		eventtotalcashContrib += cashContrib;
		cashtd.text(cashContrib);
		eventtotalcheckContrib += checkContrib;
		checktd.text(checkContrib);
		eventtotalcreditContrib += creditContrib;
		credittd.text(creditContrib);
		eventtotalrbucksContrib += rbucksContrib;
		rbuckstd.text(rbucksContrib);
		participanttd.text(participants.length + " (" + eventguests + " guests)");
	});

	eventtotalcashtd.text(eventtotalcashContrib);
	eventtotalchecktd.text(eventtotalcheckContrib);
	eventtotalcredittd.text(eventtotalcreditContrib);
	eventtotalrbuckstd.text(eventtotalrbucksContrib);

	uniq_contacts = uniq_contacts.filter( onlyUnique );

	eventtotalparticipanttd.text(uniq_contacts.length + " (unique)");
	tbody.append(eventtotaltr);

	var smallestDate = datesArr.reduce(function(previousValue, currentValue){
		if (currentValue.isBefore(previousValue)) {
			return currentValue;
		}
		return previousValue;
	});
	smallestDate.subtract('hours', 12);
	var largestDate = datesArr.reduce(function(previousValue, currentValue){
		if (currentValue.isAfter(previousValue)) {
			return currentValue;
		}
		return previousValue;
	});
	largestDate.add('hours', 12);

	//Put them in the table
	var mbtr = $("<tr>");
	var mbcashtd = $("<td>0.00</td>");
	var mbcredittd = $("<td>0.00</td>");
	var mbchecktd = $("<td>0.00</td>");
	var mbrbuckstd = $("<td>0</td>");
	var mbnewtd = $("<td>0</td>");
	mbtr.append("<td>Received:</td>")
	.append(mbcashtd)
	.append(mbcredittd)
	.append(mbchecktd)
	.append(mbrbuckstd)
	.append(mbnewtd);
	$("#member_report tbody").empty().append(mbtr);
	var mbcheckContrib = 0;
	var mbcashContrib = 0;
	var mbcreditContrib = 0;
	var mbrbucksContrib = 0;
	var new_members = 0;
	//Filter contributions for memberships made on above event days +/- 12 hours

	var membershipContributions = Caches.contributions.data.filter(function (contribution) {
		if (contribution.financial_type_id == "2" && 
				moment(contribution.receive_date).isAfter(smallestDate) && 
				moment(contribution.receive_date).isBefore(largestDate)) {
			memberships = Caches.memberships.getContactId(contribution.contact_id);
			$.each(memberships, function (idx, membership) {
				if (membership.membership_type_id == trialMembershipId) {
					//We paid in 12-something hours away from the current event
					new_members++;
				}
			});
			return true;
		}
		return false;
	});

	$.each(membershipContributions, function (idx, contribution) {
		if (contribution.instrument_id == "83") {
			mbcashContrib += parseFloat(contribution.total_amount);
		} else if (contribution.instrument_id == "84") {
			mbcheckContrib += parseFloat(contribution.total_amount);
		} else if (contribution.instrument_id == "81") {
			mbcreditContrib += parseFloat(contribution.total_amount);
		} else if (contribution.instrument_id == "720") {
			mbrbucksContrib += parseInt(contribution.total_amount);
		}
	});

	mbrbuckstd.text(mbrbucksContrib);
	mbcredittd.text(mbcreditContrib);
	mbchecktd.text(mbcheckContrib);
	mbcashtd.text(mbcashContrib);
	mbnewtd.text(new_members);

	var totaltr = $("<tr>");
	var totalcashtd = $("<td>0.00</td>");
	var totalcredittd = $("<td>0.00</td>");
	var totalchecktd = $("<td>0.00</td>");
	var totalrbuckstd = $("<td>0</td>");
	var totaltd = $("<td>0</td>");
	totaltr.append("<td>Received:</td>")
	.append(totalcashtd)
	.append(totalcredittd)
	.append(totalchecktd)
	.append(totalrbuckstd)
	.append(totaltd);
	$("#total_report tbody").empty().append(totaltr);
	var totalcheckContrib = eventtotalcheckContrib + mbcheckContrib;
	var totalcashContrib = eventtotalcashContrib + mbcashContrib;
	var totalcreditContrib = eventtotalcreditContrib + mbcreditContrib;
	var totalrbucksContrib = eventtotalrbucksContrib + mbrbucksContrib;
	totalchecktd.text(totalcheckContrib);
	totalcashtd.text(totalcashContrib);
	totalcredittd.text(totalcreditContrib);
	totalrbuckstd.text(totalrbucksContrib);
	totaltd.text(totalcheckContrib + totalcashContrib + totalcreditContrib + totalrbucksContrib);

	var totalmembercash = 0;
	var totalnonmembercash = 0;
	var totalmembercredit = 0;
	var totalnonmembercredit = 0;
	var totalmembercheck = 0;
	var totalnonmembercheck = 0;
	var totalmemberrbucks = 0;
	var totalnonmemberrbucks = 0;

	var totalmembertr = $("<tr>");
	var totalmembercashtd = $("<td>0.00</td>");
	var totalmembercredittd = $("<td>0.00</td>");
	var totalmemberchecktd = $("<td>0.00</td>");
	var totalmemberrbuckstd = $("<td>0</td>");
	var totalmembertd = $("<td>0</td>");
	totalmembertr.append("<td>Received:</td>")
	.append(totalmembercashtd)
	.append(totalmembercredittd)
	.append(totalmemberchecktd)
	.append(totalmemberrbuckstd)
	.append(totalmembertd);
	$("#total_member_report tbody").empty().append(totalmembertr);

	var totalnonmembertr = $("<tr>");
	var totalnonmembercashtd = $("<td>0.00</td>");
	var totalnonmembercredittd = $("<td>0.00</td>");
	var totalnonmemberchecktd = $("<td>0.00</td>");
	var totalnonmemberrbuckstd = $("<td>0</td>");
	var totalnonmembertd = $("<td>0</td>");
	totalnonmembertr.append("<td>Received:</td>")
	.append(totalnonmembercashtd)
	.append(totalnonmembercredittd)
	.append(totalnonmemberchecktd)
	.append(totalnonmemberrbuckstd)
	.append(totalnonmembertd);
	$("#total_nonmember_report tbody").empty().append(totalnonmembertr);

	$.each(loaded_events, function (idx, event_input) {
		//For each loaded event
		var event = Caches.events.data[$(event_input).val()];

		//Get participants filtered by event_id
		var participants = getParticipants_Event(event.id);

		$.each (participants, function (idx, participant) {
			var participant_payments = getParticipantPayment_Participant(participant.id);
			var cashContrib = 0;
			var checkContrib = 0;
			var creditContrib = 0;
			var rbucksContrib = 0;
			$.each(participant_payments, function (idx, participant_payment) {
				var contribution = getContribution (participant_payment.contribution_id);
				if (contribution.instrument_id == "83") {
					cashContrib += parseFloat(contribution.total_amount);	
				} else if (contribution.instrument_id == "84") {
					checkContrib += parseFloat(contribution.total_amount);
				} else if (contribution.instrument_id == "81") {
					creditContrib += parseFloat(contribution.total_amount);
				} else if (contribution.instrument_id == "720") {
					rbucksContrib += parseInt(contribution.total_amount);
				}
			});
			if (Caches.memberships.getContactId(participant.contact_id).length == 0) {
				//Non member
				totalnonmembercash += cashContrib;
				totalnonmembercredit += creditContrib;
				totalnonmembercheck += checkContrib;
				totalnonmemberrbucks += rbucksContrib;
			} else {
				//Member
				totalmembercash += cashContrib;
				totalmembercredit += creditContrib;
				totalmembercheck += checkContrib;
				totalmemberrbucks += rbucksContrib;
			}
		});
	});
	totalnonmembercashtd.text(totalnonmembercash);
	totalnonmembercredittd.text(totalnonmembercredit);
	totalnonmemberchecktd.text(totalnonmembercheck);
	totalnonmemberrbuckstd.text(totalnonmemberrbucks);
	totalmembercashtd.text(totalmembercash);
	totalmembercredittd.text(totalmembercredit);
	totalmemberchecktd.text(totalmembercheck);
	totalmemberrbuckstd.text(totalmemberrbucks);
	totalmembertd.text(totalmembercash + totalmembercredit + totalmembercheck + totalmemberrbucks);
	totalnonmembertd.text(totalnonmembercash + totalnonmembercredit + totalnonmembercheck + totalnonmemberrbucks);
}

/**
 * Get the Participant Payments by Participant ID
 * @param participant_id
 */
function getParticipantPayment_Participant(participant_id) {
	participant_id = parseInt(participant_id).toString();
	return Caches.participantpayments.data.filter(function (value) {
		if (typeof value == "undefined") {
			return false;
		}
		return value.participant_id == participant_id;
	});
}

/**
 * Get the Participant Payments by Contribution ID 
 * @param contribution_id
 */
function getParticipantPayment_Contribution(contribution_id) {
	contribution_id = parseInt(contribution_id).toString();
	return Caches.participantpayments.data.filter(function (value) {
		if (typeof value == "undefined") {
			return false;
		}
		return value.participant_id == participant_id;
	});
}

/**
 * This initializes all the data. Call this after logging in.
 */
function init() {
	var timeout = 0;

	progressBar.reset();
	progressBar.show();
	if (lastrun + cacheTime < runStartTime) {
		print_debug ("Last run more than 12 hours ago");
		//This ran more than 12 hours ago, get the data from server
		$.each(Caches, function (idx, cache) {
			cache.empty();
			setTimeout (function () {
				cache.fetch();
			}, timeout);
			timeout = timeout + ajaxdelay; //Wait n seconds before scheduling the next one
		});
	} else {
		$.each(Caches, function (idx, cache) {
			cache.restore();
			if (cache.data.length == 0) {
				setTimeout (function () {
					cache.fetch();
				}, timeout);
				timeout = timeout + ajaxdelay; //Wait n seconds before scheduling the next one
			}
		});
	}

	progressBar.hide();
	localStorage.setItem("lastrun", runStartTime);

	//Load the data into panels
	putContactsInSearchPanel();
	putMembershipTypesInPanel();
	putMembershipTypesInModal();
	putEventsInModal();

} //Ends function

//Load Events Click Handler
$("#load-events").click(function (event) {
	StagedTransactions.clear();
	$("#load-events-modal").modal('show');
});



/**
 * This puts the specified events in the events loading modal
 */
function putEventsInModal() {
	if (Caches.events.data.length == 0) {
		//Wait until the caches are filled
		setTimeout(putEventsInModal, 250);
		return;
	}

	$("#load-events-form .modal-body").empty();
	var now = moment();
	var back = moment(now).subtract('days', 14);
	var forward = moment(now).add('days', 14);

	if (debug) {
		back = moment(now).subtract('days', 300);
		forward = moment(now).add('days', 300);
	}

	data = Caches.events.data.filter(function (element) {
		//Test to see if we should even bother about these events
		if (moment(element.start_date).isBefore(back) || moment(element.end_date).isAfter(forward)) {
			return false;
		}
		return true;
	});

	if (data.length == 0) {
		$("#load-events-form .modal-body").append("There are no active events");
	} else {
		data.sort(function (aobj, bobj) {
			var a = moment(aobj.start_date).valueOf();
			var b = moment(bobj.start_date).valueOf();
			if(a < b) return -1;
			if(a > b) return 1;
			return 0;
		});

		$.each(data, function (index, value) {
			if ($.isEmptyObject(value)) {
				//Because of how our cache works (arrays) database ID's that are missing will be empty/undefined objects
				return;
			}

			var label = $("<label><input name='event-id[]' type='checkbox' value='" + 
					value.id + "' data-contributiontypeid='" + value["contribution_type_id"] + 
					"' data-eventtypeid='" + value["event_type_id"] + 
					"' data-event-title='" + value["event_title"] + 
					"' data-startdate='"+value["start_date"]+"'> "
					+ value["event_title"] + " ("+value["start_date"]+")</label><br>");

			var timeago = moment(value.start_date).diff(now, 'days');

			if (timeago <= -1) {
				label.css("text-decoration","line-through");
			} else if (timeago <= 1) {
				label.css("color","green");
			}
			$("#load-events-form .modal-body").append(label);

		});
	}
	//Attach a submit handler to the form
	$("#load-events-form").submit(function (event) {
		//Prevent reloading the page
		event.preventDefault();

		//For each event checked
		$("#load-events-form input[name='event-id[]']:checked").each(function () {
			var event_id = $(this).val();
			EventPanels[event_id] = new EventPanel(event_id);
		});

		$("#load-events-modal").modal('hide');
	});
}

/**
 * Calculates the start and end dates of the membership
 * Sets the membership data selected on the add button
 */
function setMembershipPriceOnButton() {
	var thisInput = $("#membership-priceFields input[name='membership-price-field']:checked");
	if (thisInput.length == 0) {
		//We haven't filled the membership panel with data yet
		setTimeout(setMembershipPriceOnButton, 250);
		return;
	}
	var dataObj = thisInput.data();
	var membershipStartDate;
	var membershipEndDate;

	if (currentContactMembership == null || !('end_date' in currentContactMembership)) {
		membershipStartDate = moment();
		membershipEndDate = moment();
	} else {
		membershipStartDate = moment(currentContactMembership.end_date);
		membershipEndDate = moment(currentContactMembership.end_date);
	}

	switch (dataObj.durationUnit) {
	//Could be year, month or lifetime
	case "year":
		membershipEndDate.add('years', (parseInt(dataObj.durationInterval) * parseInt(dataObj.membershipTerms)));
		break;
	case "month":
		membershipEndDate.add('months', (parseInt(dataObj.durationInterval) * parseInt(dataObj.membershipTerms)));
		break;
	case "lifetime":
	default:
		print_error("This membership type can only be set by a board member in the backend");
	break;
	}

	$("#membership-startDate").val(formatDate(membershipStartDate, "datepicker")); //The start date should be the CURRENT end date
	$("#membership-endDate").val(formatDate(membershipEndDate, "datepicker")); //The end date should be the end date + (durationInterval * terms)
	$("#membershipPrice").empty().append(parseFloat(dataObj.amount).toFixed(2));

	$("#membership-add").data(dataObj); //Copy all the data over
	$("#membership-add").data("amount", parseFloat(dataObj.amount).toFixed(2)); //Set the price and parse it to float, then a valid currency string
	$("#membership-dateFields").show();
}


function putMembershipTypesInModal() {
	if (Caches.membershiptypes.data.length == 0) {
		setTimeout (putMembershipTypesInModal, 250);
		return;
	}
	$.each(Caches.membershiptypes.data, function (index, membershiptype) {
		if ($.isEmptyObject(membershiptype)) {
			return;
		}
		$("#custom-membership-type").append("<option value='"+membershiptype.id+"'>"+membershiptype.name+"</option>");
	});
}

/**
 * 
 */
function putMembershipTypesInPanel() {
	if (Caches.membershiptypes.data.length == 0 || Caches.pricefieldvalues.data.length == 0 || Caches.pricefields.data.length == 0 || Caches.pricesets.data.length == 0 || LoggedInMemberships == null) {
		setTimeout(putMembershipTypesInPanel, 250);
		return;
	}

	$("#membershipType, #membership-priceFields").empty();

	var isBoardMember = debug; //If we're in debug mode then we want to see everything
	$.each(LoggedInMemberships, function (idx, value) {
		if (value.membership_type_id == boardMembershipId) {
			isBoardMember = true;
		}
	});

	//Discounts are typically price values that only occur once (eg. discount memberships)
	var discountLabel = $("<label><input name='membership-type-option' type='radio' value='Discount'> Discount</label>");
	//Special is reserved for board members only
	var specialLabel = $("<label><input name='membership-type-option' type='radio' value='Special'> Special</label>");

	$.each(Caches.membershiptypes.data, function (index, membershiptype) {
		if ($.isEmptyObject(membershiptype)) {
			return;
		}
		var thisLabel = {};

		var thisTypePrices = Caches.pricefieldvalues.data.filter(function (pfv) {
			if (typeof pfv == "undefined") {
				return false;
			}
			if (pfv.price_field_id == membershipPriceFieldId) {
				return pfv.membership_type_id == membershiptype["id"];
			}
		});

		if (membershiptype.visibility == "Public" && thisTypePrices.length <= 1 && membershiptype.id != trialMembershipId) {
			//This label is the discount label
			thisLabel = discountLabel;
			membershiptype.category = "Discount";
			//Don't append the membership type label here, do it after this $.each loop
		} else if (membershiptype.visibility != "Public") {
			//Skip this if we're not a board member
			if (!isBoardMember) {
				return;
			}
			//This label is the special label
			thisLabel = specialLabel;
			membershiptype.category = "Special";
			//Don't append the membership type label here, do it after this $.each loop
		} else {
			//This label is a new label
			membershiptype.category = membershiptype.id;
			thisLabel = $("<label>");
			thisLabel.append("<input name='membership-type-option' type='radio' value='" + membershiptype.id + "'> " + membershiptype.name + "</label>");
			//Make sure we append this label to the membership types
			$("#membershipType").append(thisLabel);
			$("#membershipType").append(" ");
		}

		$.each(thisTypePrices, function (index, price) {
			var is_def = "";
			var thisPriceField = $("<label style='display:none' data-membershipcategory='" + membershiptype.category + "'></label>");
			var thisInput = $("<input name='membership-price-field' type='radio' data-amount='" + price["amount"] + "' data-membership-terms='" + price["membership_num_terms"] + "' data-membership-type='" + price.membership_type_id + "' data-duration-unit='" + membershiptype["duration_unit"] + "' data-duration-interval='" + membershiptype["duration_interval"] + "' data-txlabel='" + membershiptype["description"] + "' data-membership-name='" + membershiptype["name"] + "'" + is_def + ">");

			if (price["is_default"] != 0) {
				thisLabel.find("input").prop("checked", true);
				thisLabel.attr("data-defaultmembership", "1");
				thisPriceField.attr("style", "");
				thisPriceField.attr("data-defaultmembership", "1");
				thisInput.prop("checked", true);
				$("label[data-membershipcategory='" + membershiptype.category + "']").show();
			} else if (thisLabel.find("input").prop("checked")) {
				thisPriceField.attr("style", ""); //Make sure we show this option if we are part of the default group
			};

			thisPriceField.append(thisInput);
			thisPriceField.append(" " + price["label"]);
			$("#membership-priceFields").append(thisPriceField);
			$("#membership-priceFields").append(" ");
		});
	});
	//This is the list of discounts
	$("#membershipType").append(discountLabel).append(" ");

	//This is the list of special items, only board members should see this
	if (isBoardMember) {
		$("#membershipType").append(specialLabel).append(" ");
		var otherPriceField = $("<label style='display:none' data-membershipcategory='Special'> Other</label>");
		var otherInput = $("<input name='membership-type-option' type='radio' data-toggle='modal' data-target='#custom-membership-modal'>");
		otherPriceField.prepend(otherInput);

		$("#membership-priceFields").append(otherPriceField);
	}

	//Attach click handlers to the new membership-type-options
	$("input[name='membership-type-option']").click(function (event) {
		if (currentContact == null) {
			print_error("No contact selected");
			return false;
		}
		$("label[data-membershipcategory]").hide();
		$("label[data-membershipcategory='" + $(this).val() + "']").show();
	});

	//Attach click handlers to the membership-price-fields
	$("input[name='membership-price-field']").click(function (event) {
		setMembershipPriceOnButton($(this).data());
	});
}

//Attach a click handler to the membership-add button
$("#membership-add").click(function (event) {
	if (currentContact == null) {
		print_error("No contact loaded");
	} else if ($(this).data("membership-type") == 0) {
		print_error("You forgot to select a membership type");
	} else {
		//Prepare a transaction
		$(this).data("startdate", $("#membership-startDate").val());
		$(this).data("enddate", $("#membership-endDate").val());
		prepare_member_tx($(this).data());
	}
});

$("#custom-membership-form").submit(function (event) {
	event.preventDefault(); //Prevent the page from reloading

	$("#custom-membership-modal").modal('hide'); //Hide the modal
	var data = {};
	data.fields = {};
	data.type = "membership";
	data.price = parseFloat($("#custom-membership-price").val());
	data.contactid = currentContact.id;
	data.fields.membership_source = "Custom Doorsheet v" + version;
	data.fields.membership_contact_id = currentContact.id;
	if (currentContactMembership == null) {	
		data.fields.membership_start_date = formatDate("", "database");
		data.fields.join_date = formatDate("", "database");
		data.fields.status_id = 1;
	} else {
		data.membershipId = currentContactMembership.id;
		data.fields.id = data.membershipId;
		data.fields.status_id = 2;
	}
	data.fields.membership_type_id = $("#custom-membership-type").val();
	data.fields.membership_end_date = formatDate($("#custom-membership-enddate").val(), "database");
	StagedTransactions.add (data);
}); 

function StagedTransactions () {
	var context = this;
	this.data = [];
	this.total = 0;

	this.add = function (transaction) {
		if (!("type" in transaction) || transaction.type == "") {
			print_error("BUG: No type passed into the transaction");
			return false;
		}
		if (!("contactid") in transaction || transaction.contactid == 0) {
			print_error ("BUG: No contactid passed into the transaction");
			return false;
		}
		if (!("price") in transaction) {
			print_error ("BUG: No price passed into the transaction");
			return false;
		}
		if (transaction.price != 0 && !("fields" in transaction)) {
			print_error("BUG: A price passed but no fields to update in the database");
			return false;
		}
		print_debug (transaction);
		var text = Caches.contacts.getNickName(transaction.contactid) + ": $" + parseFloat(transaction.price).toFixed(2);
		var txid = context.data.push(transaction) - 1;
		var dismiss_button = $("<button type='button' class='close' data-dismiss='alert' aria-hidden='true' data-txid='"+txid+"'>&times;</button>");
		dismiss_button.click(function (event) {
			StagedTransactions.remove($(this).data("txid"));
		});

		switch (transaction.type) {
		case "discount":
			if ("credit" in transaction.fields && transaction.fields.credit != 0) {
				text += '<br>$' + parseFloat(transaction.fields.credit).toFixed(2) +  ' Credit';
			}
			if ("rbucks" in transaction.fields && transaction.fields.rbucks != 0) {
				text += '<br>' + transaction.fields.rbucks +  ' RBucKS';
			}
			if ("guestpasses" in transaction.fields && transaction.fields.guestpasses != 0) {
				text += '<br>' + transaction.fields.guestpasses +  ' Guest Pass(es)';
			}
			break;
		case "event":
			text += " - " + Caches.events.data[transaction.fields.event_id].title;
			break;
		case "membership":
			text += " - " + Caches.membershiptypes.data[transaction.fields.membership_type_id].name + " Membership";
			break;
		default:
			print_error("BUG: Invalid type passed into the transaction");
		}

		var txdiv = $("<div class='txinfo' id='StagedTx-"+txid+"'>" + text + "</div>").prepend(dismiss_button);
		$("#transaction-info").append(txdiv);

		context.total += transaction.price;
		context.updateView();
		return txid;
	};

	this.remove = function (id) {
		$('#StagedTx-' + id).remove();
		context.total -= context.data[id].price;
		delete context.data[id];
		context.updateView();
	};

	this.clear = function () {
		context.data.clear();
		context.total = 0;
		context.updateView();
		$("#transaction-info").empty();
	};

	this.updateView = function () {
		$("#transaction-total").text(parseFloat(context.total).toFixed(2)); //toFixed transforms this into a string
		if (context.total > 0) {
			$("#transaction-total").addClass('attention-quick');
		} else {
			$("#transaction-total").removeClass('attention-quick');
		}
	};

	this.refresh = function () {
		context.total = 0;
		for (var i = 0; i < context.data.length; i++) {
			if (typeof(context.data[i]) == "undefined") {
				continue;
			}
			context.total += context.data[i].price;
		}
		context.updateView();
	};
}

/**
 * Prepare membership transaction (put it in the list to be processed)
 * @param dataObj
 */
function prepare_member_tx(dataObj) {
	//Make sure we're not accidentally passing objects or strings 
	var price = parseFloat(dataObj["amount"]);
	var memberType = parseInt(dataObj["membershipType"]);

	//Name:
	var data = {};
	data.type = "membership";
	data.price = price;
	data.contactid = currentContact.id;
	data.fields = {};

	/*
	 * membership_contact_id=3&membership_type_id=2&status_id=1&id=4&membership_end_date=2014
	 */
	if (currentContactMembership != null) {

		data.fields.id = data.membershipId;
		data.fields.membership_contact_id = data.contactid;
		data.fields.status_id = 2;
	} else {
		//New membership should have a start date
		data.fields.membership_start_date = formatDate($("#membership-startDate").val(), "database");
		data.fields.join_date = data.fields.membership_start_date;
		data.fields.membership_source = "Doorsheet " + version;
		data.fields.membership_contact_id = data.contactid;
		data.fields.status_id = 1;
	}
	data.fields.membership_type_id = memberType;
	data.fields.membership_end_date = formatDate($("#membership-endDate").val(), "database");
	//Save this transaction into the local transaction list
	StagedTransactions.add(data);
}

/**
 * @param paymentData
 */
function submitTransaction(paymentData) {
	print_debug ("Processing Staged Transactions:");

	/**
	 * We bind the discountAvailable to this function so we use the same shared variable
	 */
	var discountAvailable = 0;
	$.each(StagedTransactions.data, function (key, transaction) {
		if (typeof transaction == "undefined") {
			//If we partially cancel a transaction, individual elements may be undefined
			return;
		}

		if (transaction.type == "discount") {
			print_debug ("Processing discount");
			discountAvailable += parseFloat(transaction.price);
			var query = {};
			query.entity="Contact";
			query.action="create";
			query.id=transaction.contactid;
			if ("credit" in transaction.fields && transaction.fields.credit != 0) {
				//We need to parseFloat and then toFixed so we don't get multiple digits after the comma (rounding errors) which the database doesn't like
				query.custom_3 = parseFloat(parseFloat(getCustomValue(transaction.contactid, 3)) - parseFloat(transaction.fields.credit)).toFixed(2);
				//Make sure to set the new data on the contact so we can reuse it for the next transaction
				//logTransactions does this as well but since this is async, we need to make sure the next loop has correct data
				Caches.contacts.data[query.id].custom_3 = query.custom_3;
				Caches.contacts.data[query.id].credit= query.custom_3;
			}
			if ("rbucks" in transaction.fields && transaction.fields.rbucks != 0) {
				query.custom_4 = parseInt(getCustomValue(transaction.contactid, 4)) - parseInt(transaction.fields.rbucks);
				Caches.contacts.data[query.id].custom_4 = query.custom_4;
				Caches.contacts.data[query.id].rbucks = query.custom_4;
			}
			if ("guestpasses" in transaction.fields && transaction.fields.guestpasses > 0) {
				query.custom_5 = parseInt(getCustomValue(transaction.contactid, 5)) - parseInt(transaction.fields.guestpasses);
				Caches.contacts.data[query.id].custom_5 = query.custom_5;
				Caches.contacts.data[query.id].guestpasses = query.custom_5;
			}

			$.ajax({
				url: CRMRESTURL,
				data: query,
				type: "POST",
				dataType: "json"})
				.done(function(data, textStatus) {
					if (!test_apidata_error(data, "Successfully processed discounts", "Error updating discounts")) {
						return false;
					}
					query.id = data.id;
					//Log the transaction
					logTransaction(query, textStatus);
				})
				.fail(function (jqXHR, textStatus, errorThrown) {
					print_error("Error updating Discount on Contact: "+errorThrown+", please update discounts manually");
				});
		}
	});

	$.each(StagedTransactions.data, function (key, transaction) {
		if (typeof transaction == "undefined") {
			return;
		}
		if (!("type" in transaction)) {
			print_error("BUG: Attempted transaction execution without a type");
			return;
		}
		if (transaction.type == "discount") {
			//We don't process discounts here
			return;
		}

		transaction.paymentData = paymentData;
		transaction.price = parseFloat(transaction.price);
		transaction.discountUsed = 0;
		transaction.discountType = 6; //Instrument Type 6 = RBucKS
		if (transaction.price > 0 && discountAvailable < 0) {
			if ((transaction.price + discountAvailable) <= 0) {
				//This happens when the discount is greater than the individual price

				discountAvailable += transaction.price;
				transaction.discountUsed = transaction.price; //We got the entire price as a discount
				transaction.price = 0; //THE ORDER OF THESE 2 LINES IS IMPORTANT!
			} else {
				transaction.price += discountAvailable;
				transaction.discountUsed = discountAvailable * -1; //Discount is a negative value
				discountAvailable = 0;
			}
		}

		print_debug (transaction);
		execTransaction(transaction);
	});
	StagedTransactions.clear();
}

/**
 * @param contactid
 * @param typeid
 * @returns
 */
function getCustomValue(contactid, typeid) {
	return Caches.contacts.data[contactid]["custom_"+typeid];
}

/**
 * Execute a particular transaction
 * @param element Object with the transaction
 * @returns {Boolean}
 */
function execTransaction(element) {
	var query = {};
	var paymentData = {};
	print_debug ("Executing transaction");

	switch (element.type) {
	case "membership":
		/*
			Membership template 
		 */
		paymentData.financialTypeId = 2; //2 = Member dues
		query.entity = "Membership";
		query.action = "create";
		if ("id" in element.fields) {
			//This is an update rather than a new one
			query.id = element.fields.id;
		} else {
			query.membership_start_date = element.fields.membership_start_date;
			query.join_date = element.fields.join_date;
			query.membership_source = "Doorsheet Membership v" + version;
		}
		query.membership_contact_id = element.fields.membership_contact_id;
		query.membership_type_id = element.fields.membership_type_id;
		query.membership_end_date = element.fields.membership_end_date;
		query.status_id = element.fields.status_id;
		/*
			End Membership template
		 */
		break;
	case "event":
		/*
			Participant template 
		 */
		paymentData.financialTypeId = 4; //4 = Event fees
		query.entity = "Participant";
		query.action = "create";
		query.participant_contact_id = parseInt(element.fields.participant_contact_id);
		query.contact_id = query.participant_contact_id;
		query.event_id = element.fields.event_id;

		//See if we are already registered
		var thisparticipant_id = getParticipantId_Contact_Event(query.contact_id, query.event_id);
		if (thisparticipant_id > 0) {
			//We are registered, update the old record
			query.id = thisparticipant_id;
			query.participant_id = thisparticipant_id;
		} else {
			//We are not yet registered, set when we registered and the default role
			query.participant_register_date = element.fields.participant_register_date;
			query.participant_role_id = element.fields.participant_role_id;
			query.participant_source = "Doorsheet Event v"+version;
		}	
		query.participant_status_id = element.fields.participant_status_id;
		query.status_id = element.fields.participant_status_id;
		query.participant_fee_amount = element.price;
		query.participant_fee_currency = "USD";
		/*
			End Participant template
		 */
		break;
	default:
		print_error("BUG: Unknown type passed");
	print_debug(element);
	return false;
	break;
	}
	paymentData.price = parseFloat(element.price);
	paymentData.contactid = parseInt(element.contactid);
	paymentData.instrumentType = parseInt(element.paymentData.instrumentType);
	paymentData.discountUsed = parseFloat(element.discountUsed);
	paymentData.discountType = parseInt(element.discountType);
	$.ajax({
		url: CRMRESTURL,
		data: query,
		type: "POST",
		dataType: "json"})
		.done(function(data, textStatus) {
			var errorMsg = "Error updating "+query.entity+": "+data["error_code"]+", please re-submit last "+query.entity+" transaction";
			var successMsg = query.entity+" successfully processed";
			if (!test_apidata_error(data, successMsg, errorMsg)) {
				return false;
			}
			query.id = data.id;

			//Log the transaction
			logTransaction(query, textStatus);
			//Log the actual payment if we have a price left
			if (parseFloat(paymentData.price) != 0) {
				createContribution(paymentData, data.id);
			}
			//Basically we log up to 2 payments if we have a discount
			//one for the actual payment (if any left) and one for the discount (if any)
			if (parseFloat(paymentData.discountUsed) != 0) {
				/**
				 * Discount is a payment with almost all the same properties except for instrumentType and price  
				 */
				var discountData = paymentData;
				discountData.instrumentType = paymentData.discountType;
				discountData.price = paymentData.discountUsed;
				createContribution(discountData, data.id);
			}
		})
		.fail(function (jqXHR, textStatus, errorThrown) {
			print_error("Error processing "+query.entity+": "+errorThrown+", please re-submit last "+query.entity+" transaction");
		});
}

/**
 * @param data
 * @param successMsg
 * @param errorMsg
 * @returns {Boolean} Returns false on error, true on success
 */
function test_apidata_error(data, successMsg, errorMsg) {
	if (!("is_error" in data) || data.is_error > 0) {
		if (!("is_error") in data) {
			errorMsg+": No or Invalid data returned";
		}

		if ("error_message" in data) {
			//The server returned a specific error
			errorMsg+": "+ data.is_error + " - " + data.error_message;
		}
		print_error(errorMsg);
		return false;
	}
	print_success(successMsg);
	return true;
}

/**
 * @param inquery
 * @param textStatus
 */
function logTransaction(query, textStatus) {
	print_debug (query);
	var cache = null;
	var baseurl = "https://crmv1.rochesterkinksociety.com/index.php";
	var url = "";
	switch (query.entity) {
	case "Contact":
		cache = Caches.contacts;
		if (typeof query.last_name != "undefined" && typeof query.first_name != "undefined") {
			query.sort_name = query.last_name + ", " + query.first_name;
		}
		//Make sure we don't mess up things that are still looping
		if ("custom_3" in query) {
			delete query.custom_3;
		}
		if ("custom_4" in query) {
			delete query.custom_4;
		}
		if ("custom_5" in query) {
			delete query.custom_5;
		}
		url = "?q=civicrm/contact/view&reset=1&cid="+query.id;
		break;
	case "Membership":
		cache = Caches.memberships;
		query.membership_name = $("#custom-membership-type option[value='"+query.membership_type_id+"']").text();
		query.end_date = query.membership_end_date;
		query.contact_id = query.membership_contact_id;
		//?q=civicrm/contact/view/membership&action=view&reset=1&cid=284&id=224&context=membership&selectedChild=member
		url = "?q=civicrm/contact/view/membership&action=view&reset=1&id="+query.id+"&cid="+query.contact_id+"&context=membership&selectedChild=member";
		break;	
	case "ParticipantPayment":
		cache = Caches.participantpayments;
		break;
	case "MembershipPayment":
		return; //We don't log this (for now, this is part of contribution)
		break;
	case "Contribution":
		cache = Caches.contributions;
		query.financial_type_id = query.financial_type_id.toString();
		query.instrument_id = query.contribution_payment_instrument_id.toString();
		query.contribution_payment_instrument_id = query.contribution_payment_instrument_id.toString();
		if (query.financial_type_id == "2") {
			query.financial_type = "Member Dues";
		} else {
			query.financial_type = "Event Fee";
		}		
		if (query.instrument_id == "83" || query.instrument_id == "3") {
			query.payment_instrument = "Cash";	
			query.instrument_id == "83";
		} else if (query.instrument_id == "84" || query.instrument_id == "4") {
			query.payment_instrument = "Check";
			query.instrument_id == "84";
		} else if (query.instrument_id == "81" || query.instrument_id == "1") {
			query.payment_instrument = "Credit";
			query.instrument_id == "81";
		} else if (query.instrument_id == "720" || query.instrument_id == "6") {
			query.payment_instrument = "RBucKS";
			query.instrument_id == "720";
		}
		query.total_amount = parseFloat(query.total_amount).toFixed(2);
		url = "?q=civicrm/contact/view/contribution&reset=1&action=view&id="+query.id+"&cid="+query.contact_id+"&context=contribution&selectedChild=contribute";
		break;
	case "Participant":
		cache = Caches.participants;
		query.contact_id = query.participant_contact_id;
		query.event_title = Caches.events.data[query.event_id].event_title;
		url = "?q=civicrm/contact/view/participant&reset=1&action=view&id="+query.id+"&cid="+query.contact_id+"&context=search&selectedChild=event&compContext=participant";
		break;
	default:
	case "MembershipType":
	case "Event":
	case "PriceSet":
	case "PriceField":
	case "PriceFieldValue":
		print_error ("BUG: An entity ("+query.entity+") that should not be updated is being updated");
		return;
		break;
	}

	var newObj = {};
	for (var key in query) {
		//Filter out the entity and action keys, they are there for the API, they're not actual data
		if (key == "entity" || key == "action") {
			continue;
		}
		newObj[key] = query[key];
	}
	print_debug ("Cache object update");
	print_debug (newObj);
	cache.addItem(newObj);
	cache.save();

	putContactsInSearchPanel();
	putMembershipsInPanel();
	putLastParticipantsInPanel();
	putLastPaymentsInPanel();

	var tr = $("<tr>");
	tr.append("<td>"+formatDate("", "database-time")+"</td><td>"+query.entity+"</td><td>"+query.action+"</td><td>"+query.id+"</td><td>"+textStatus+"</td>");
	var edittd = $("<td></td>");
	if (url != "") {
		edittd.append("<a href='"+baseurl + url+"'>Edit in backend</a>");
	}
	tr.append(edittd);
	$("#transactions-table tbody").prepend(tr);
	//Limit this
	//Safari/Chrome can store 2,600,000 characters per domain. Our database may take up to half of that (currently 371,507 characters)
	//Each transaction takes ~100 characters to store - 1000 (10,000 characters) should be fine
	var all_transactions = $("#transactions-table tbody tr");
	while (all_transactions.length > 1000) {
		all_transactions.pop();
	}
	localStorage.setObject("TxInfo", all_transactions.html());
}

/**
 * Create a contribution
 * @param paymentData The payment data
 * @param data_id The id to link the payment to (whether membership or participant will depend on financial_type_id)
 */
function createContribution(paymentData, data_id) {
	/**
	 * Contribution template
	 */
	print_debug ("Creating contribution");

	var contribQuery = {};
	contribQuery.entity = "Contribution";
	contribQuery.action = "create";
	contribQuery.financial_type_id = paymentData.financialTypeId;
	contribQuery.contact_id = paymentData.contactid;
	contribQuery.currency = "USD";
	contribQuery.receive_date = formatDate("", "db-time");
	contribQuery.total_amount = paymentData.price;
	contribQuery.contribution_source = "Doorsheet Contribution v" + version;
	contribQuery.contribution_status_id = 1;
	contribQuery.contribution_payment_instrument_id = paymentData.instrumentType;

	$.ajax({
		url: CRMRESTURL,
		data: contribQuery,
		type: "POST",
		cache: false,
		dataType: "json"})
		.done(function(data, textStatus) {
			if (!test_apidata_error (data, "Contribution successfully processed", "Error updating contribution")) {
				if (contribQuery.financial_type_id == 4) {
					//4 = event fee
					rollbackParticipant(data_id);
				} else if (contribQuery.financial_type_id == 2) { 
					//2 = member due
					rollbackMembership(data_id);
				} else {
					print_error ("BUG: Undefined or unknown financial type ID");
					//Unknown contribution type
				}
				return false;
			}
			contribQuery.id = data["id"];

			logTransaction(contribQuery, textStatus);
			if (contribQuery.financial_type_id == 4) {
				//4 = event fee
				createParticipantPayment(data.id, data_id);
			} else if (contribQuery.financial_type_id == 2) { 
				//2 = member due
				createMembershipPayment(data.id, data_id);
			} else {
				print_error ("BUG: Undefined or unknown financial type ID");
				//Unknown contribution type
			}

		})
		.fail(function (jqXHR, textStatus, errorThrown) {
			print_error("Error processing "+contribQuery.entity+": "+errorThrown+", please re-submit last "+contribQuery.entity+" transaction");
			if (contribQuery.financial_type_id == 4) {
				//4 = event fee
				rollbackParticipant(data_id);
			} else if (contribQuery.financial_type_id == 2) { 
				//2 = member due
				rollbackMembership(data_id);
			} else {
				print_error ("BUG: Undefined or unknown financial type ID");
				//Unknown contribution type
			}
			return false;
		});
}

/**
 * @param contributionId
 * @param membershipId
 */
function createMembershipPayment(contributionId, membershipId) {
	var query = {};
	query.entity = "MembershipPayment";
	query.action = "create";
	query.contribution_id = contributionId;
	query.membership_id = membershipId;

	$.ajax({
		url: CRMRESTURL,
		data: $.param(query),
		type: "POST",
		cache: false,
		dataType: "json"})
		.done(function(data, textStatus) {
			var errorMsg = "Error processing "+query.entity+", rolling back Membership and Contribution transaction";
			var successMsg = "Successfully registered membership payment";
			if (!test_apidata_error(data, successMsg, errorMsg)) {
				//Nothing was done, alert
				rollbackMembership(membershipId);
				rollbackContribution(contributionId);
				return false;
			}
			query.id = data["id"];
			logTransaction(query, textStatus);
		}).fail(function (jqXHR, textStatus, errorThrown) {
			print_error("Error processing "+query.entity+": "+errorThrown+", rolling back Membership and Contribution transaction");
			rollbackMembership(membershipId);
			rollbackContribution(contributionId);
		});

}

/**
 * @param contributionId
 * @param participantId
 */
function createParticipantPayment(contributionId, participantId) {
	var query = {};
	query.entity = "ParticipantPayment";
	query.action = "create";
	query.contribution_id = contributionId;
	query.participant_id = participantId;

	$.ajax({
		url: CRMRESTURL,
		data: $.param(query),
		type: "POST",
		cache: false,
		dataType: "json"})
		.done(function(data, textStatus) {
			var errorMsg = "Error processing "+query.entity+", please re-submit last "+query.entity+" transaction";
			var successMsg = "Successfully registered participant payment";
			if (!test_apidata_error(data, successMsg, errorMsg)) {
				//Nothing was done, alert
				rollbackParticipant(participantId);
				rollbackContribution(contributionId);
				return false;
			}
			query.id = data["id"];
			logTransaction(query, textStatus);
		})
		.fail(function (jqXHR, textStatus, errorThrown) {
			print_error("Error processing "+query.entity+": "+errorThrown+", rolling back Participant and Contribution transaction");
			rollbackParticipant(participantId);
			rollbackContribution(contributionId);
		});

}

/**
 * Roll back a failed membership update. This will query the membership from cache.
 * @param membershipId
 */
function rollbackMembership(membershipId) {
	var query = {};
	if ($.isEmptyObject(Caches.memberships.data[membershipId])) {
		query.entity = "Membership";
		query.id = membershipId;
		query.action = "delete";
		//This will also delete the payment!!!
	} else {
		//Grab the query data from the cache
		query = Caches.memberships.data[membershipId];
		query.action = "create";
		query.id = membershipId;
	}

	$.ajax({
		async: true,
		type: "POST",
		url: CRMRESTURL,
		data: query,
		dataType: "json", //Don't forget to say this, the return check will fail otherwise
	})
	.done(function (data, textStatus, jqXHR) {
		print_success("Membership data successfully rolled back");
		logTransaction(query, textStatus);
	})
	.fail(function (jqXHR, textStatus, errorThrown) {
		print_error("Membership data could not be rolled back, are we connected to the Internet?");
		print_error("Contact Sparlock to do this manually" + textStatus + " " + errorThrown);
	});
}

/**
 * @param participantId
 */
function rollbackParticipant (participantId) {
	var fields = {};
	fields.entity="Participant";
	fields.action="delete";
	fields.id=participantId;
	var errorDetails = $.param(fields);
	//This will also delete the payment

	$.ajax({
		async: true,
		type: "POST",
		url: CRMRESTURL,
		data: fields,
		dataType: "json", //Don't forget to say this, the return check will fail otherwise
	})
	.done(function (data, textStatus, jqXHR) {
		print_success("Participant data successfully rolled back");
		fields.id = data["id"];
		logTransaction(fields, textStatus);
	})
	.fail(function (jqXHR, textStatus, errorThrown) {
		print_error("Participant data could not be rolled back, are we connected to the Internet?");
		print_error("Contact Sparlock to do this manually" + errorDetails);
	});
}

/**
 * @param contributionId
 */
function rollbackContribution (contributionId) {
	var fields = {};
	fields.entity="Contribution";
	fields.action="delete";
	fields.id=contributionId;
	var errorDetails = $.param(fields);

	$.ajax({
		type: "POST",
		url: CRMRESTURL,
		data: fields,
		dataType: "json", //Don't forget to say this, the return check will fail otherwise
	})
	.done(function (data, textStatus, jqXHR) {
		print_success("Contribution data successfully rolled back");
		query.id = data["id"];
		logTransaction(query, textStatus);
	})
	.fail(function (jqXHR, textStatus, errorThrown) {
		print_error("Contribution data could not be rolled back, are we connected to the Internet?");
		print_error("Contact Sparlock to do this manually" + errorDetails);
	});
}

/**
 * Process the login of a user and loads the associated data
 * @param username
 * @param api_key
 */
function login_user (username, api_key) {
	//Make sure impatient people don't process a slow login twice
	lock_uiobject($("#login-modal button, #login-modal input"));
	this.username = username;
	this.api_key = api_key;

	/**
	 * Process a successful login
	 * @param username The username that was used
	 * @param temp_key The key that was used
	 */
	this.login_success = function (username, temp_key) {
		if ($("#remember_login").prop( "checked" )) {
			localStorage.setItem("user_api_key", temp_key);
			localStorage.setItem("user_login", username);
		}
		CRMRESTURL = CRMRESTURLorig + "&api_key=" + temp_key;
		setLoggedInUser(username);
		init();
		$("#login-modal").modal('hide');
		$("#btn-login").button('reset');
		unlock_uiobject($("#login-modal button, #login-modal input"));
	};
	/**
	 * Process a failed login
	 * @param reason The reason it failed
	 * @param key The key that was used
	 */
	this.login_fail = function (reason, temp_key) {
		localStorage.removeItem("user_api_key");
		localStorage.removeItem("user_login");
		reason = reason + "<br>If you recently updated your password or this is your first time using this system, give an admin this hash: " + temp_key;
		$("#login-modal").modal('show'); //In case the saved login fails, we need to show the login modal
		$("#login-error").show().empty().append(reason);
		$("#btn-login").button('reset');
		unlock_uiobject($("#login-modal button, #login-modal input"));
	};

	var query = {};
	query.entity = "Contact";
	query.action = "get";
	query.api_key = api_key;
	//Custom_1 = banned
	//Custom_2 = no guest
	//Custom_3 = credit 
	//Custom_4 = rbucks
	//custom_5 = guest passes
	query['return'] = "nick_name,sort_name,first_name,last_name,email,custom_1,custom_2,custom_3,custom_4,custom_5";
	$.ajax({
		url: CRMRESTURL,
		dataType: "json", //Don't forget to say this, it will fail otherwise
		data: query,
		context: this
	})
	.done(function (data, textStatus, jqXHR) {
		var successMsg = "Successfully cached Contacts";
		var errorMsg = "Error caching Contacts";
		if (!test_apidata_error(data, successMsg, errorMsg)) {
			this.login_fail (data['error_message'], this.api_key);
			return false;
		}
		Caches.contacts = new Cache ("Contact");
		Caches.contacts.setData(data.values);

		this.login_success(this.username, this.api_key);
	}).fail(function (jqXHR, textStatus, errorThrown) {
		print_error("Error caching Contacts: " + textStatus + " - " + errorThrown);
		this.login_fail("Error connecting to the server: "+textStatus+" - "+errorThrown);
	});
}

function putContactsInSearchPanel () {
	if (Caches.contacts.data.length == 0) {
		setTimeout (putContactsInSearchPanel, 250);
		return;
	}

	function searchData (contact) {
		return contact.nick_name+" "+contact.sort_name+" "+contact.email;
	}

	var contactdata = Caches.contacts.data.filter(function(n){ return (typeof n != "undefined"); }).sort(function(a, b) {
		if (!('nick_name' in a) || !('nick_name') in b) {
			//Prevent errors from halting the script
			return false;
		} 
		return a.nick_name.toUpperCase().localeCompare(b.nick_name.toUpperCase());
	});

	$("#contact-nickname").select2({
		placeholder: "Search by Scene Name",
		data: {results: contactdata, text: searchData},
		formatResult: function (contact) { return contact.nick_name+" ("+contact.sort_name+" - "+contact.email+")"; },
		formatSelection: function (item) { return item.nick_name; }
	});
	$("#contact-email").select2({
		placeholder: "Search by E-mail",
		data: {results: contactdata, text: searchData},
		formatResult: function (contact) { return contact.email+" ("+contact.nick_name+" - "+contact.sort_name+")"; },
		formatSelection: function (item) { return item.email;}
	});
	$("#contact-name").select2({
		placeholder: "Search by Full Name",
		data: {results: contactdata, text: searchData},
		formatResult: function (contact) { return contact.sort_name+" ("+contact.nick_name+" - "+contact.email+")"; },
		formatSelection: function (item) { return item.sort_name; }
	});

	$("#contact-nickname, #contact-email, #contact-name").change(function (event) {
		changeActiveContact($(this).val()); //Change the current contact
	});
}

/**
 * Deletes local user data and shows the login modal
 */
function logout_user () {
	localStorage.clear();
	location.reload();
}

function setLoggedInUser (nick_name) {
	var lock = $("input");
	if(Caches.memberships.data.length != 0 && Caches.contacts.data.length != 0) {
		//Wait until all the caches we need are filled
		var user = Caches.contacts.data.filter(function (contact) {
			if (typeof contact == "undefined") {
				return;
			}
			return contact.nick_name.toLowerCase() == nick_name.toLowerCase();
		});
		if (user.length == 0) {
			print_error ("Your scene name does not match an existing contact or you do not have access to the (complete) contact list");
			return false;
		} else if (user.length > 1) {
			print_error ("More than one person in the contact database has the same scene/user name as you!");
			return false;
		}
		LoggedInUser = user[0]; //Select the only result
		LoggedInMemberships = Caches.memberships.getContactId(LoggedInUser.id);
		if (LoggedInMemberships.length == 0) {
			print_error ("You were logged in but you do not have a (valid) membership!");
			return false;
		}
		//Sometimes we get stuff from cache
		if (islocked_uiobject(lock)) {
			unlock_uiobject(lock);
		}
		$("#loggedinUsername").text(LoggedInUser.nick_name);
	} else {
		if (!islocked_uiobject(lock)) {
			lock_uiobject(lock);
		}
		//Wrap it in a function so it is scheduled and doesn't exceed stack size
		setTimeout(function () {setLoggedInUser(nick_name);}, 250);
	}
}
/**
 * This functions prints a system-facing message for debugging purposes
 * This can usually be read using some type of developer mode or firebug
 * Use print_warning, print_success or print_error for user-facing messages 
 * @param item The object to print out in the console
 */
function print_debug(item) {
	if (debug) {
		$("#debug_span").prepend("<br>").prepend(document.createTextNode("DEBUG: " + item));
		$("#debug").show();
		//Set a breakpoint here to inspect the data
		item;
	}

	//Leave these here, they may be useful
	if (console && console.log) {
		console.log("DEBUG:", item);
	}
}

/**
 * This functions prints a user-facing warning message
 * For internal warnings that do not impact users, use print_debug
 * @param item
 */
function print_warning(text) {
	if (console && console.log) {
		console.log("WARNING:", text);
	}
	var warning_div = $("#warning");
	var warning_span = $("#warning_span");
	if (warning_div.length == 0) {
		//We dismissed the warning div or it was not created yet, recreate it
		warning_div = $('<div class="row alert alert-warning" id="warning" style="display: none; height: 100px; overflow: auto;"><button type="button" class="close" data-dismiss="alert" aria-hidden="true">&times;</button></div>');
		warning_span = $('<span id="warning_span"></span>');
		warning_div.append(warning_span);
		$("#alerts").append(warning_div);
	}
	warning_span.prepend("<br>");
	warning_span.prepend(document.createTextNode("WARNING: " + text));
	warning_div.show();
}

/**
 * This function prints a user-facing success. 
 * For internal successes that do not impact users, use print_debug
 * @param text
 */
function print_success (text) {
	if (console && console.log) {
		console.log("SUCCESS:", text);
	}
	var success_div = $("#success");
	var success_span = $("#success_span");
	if (success_div.length == 0) {
		//We dismissed the success div or it was not created yet, recreate it
		success_div = $('<div class="row alert alert-success" id="success" style="display: none; height: 100px; overflow: auto;"><button type="button" class="close" data-dismiss="alert" aria-hidden="true">&times;</button></div>');
		success_span = $('<span id="success_span"></span>');
		success_div.append(success_span);
		$("#alerts").append(success_div);
	}
	success_span.prepend("<br>");
	success_span.prepend(document.createTextNode("SUCCESS: " + text));
	success_div.show();
}

/**
 * This will create an error message and show it to the user, also logs to console
 * If you do not want to show certain errors to users, use print_debug
 * @param text Text to print out
 */
function print_error(text) {
	if (console && console.log) {
		console.log("ERROR:", text);
	}
	var error_div = $("#error");
	var error_span = $("#error_span");
	if (error_div.length == 0) {
		//We dismissed the error div or it was not created yet, recreate it
		error_div = $('<div class="row alert alert-danger" id="error" style="display: none; height: 100px; overflow: auto;"><button type="button" class="close" data-dismiss="alert" aria-hidden="true">&times;</button></div>');
		error_span = $('<span id="error_span"></span>');
		error_div.append(error_span);
		$("#alerts").append(error_div);
	}
	error_span.prepend("<br>");
	error_span.prepend(document.createTextNode("ERROR: " + text));
	error_div.show();
}

/**
 * Call this whenever the member fields are to be updated
 * @param contact_id
 */
function changeActiveContact(contact_id) {
	if (contact_id == null) {
		print_error ("BUG: Contact ID passed is null");
		return;
	}

	$("#contact-name").select2("val", contact_id);
	$("#contact-email").select2("val", contact_id);
	$("#contact-nickname").select2("val", contact_id);
	$("#error").hide();
	$("#success").hide();
	$("#warning").hide();
	$("#debug").hide();

	//Get the membership data
	currentContact = getContact(contact_id);
	currentContactMembership = null;

	putMembershipsInPanel();
	putLastPaymentsInPanel ();
	putLastParticipantsInPanel ();				
}

function putLastPaymentsInPanel () {
	if (currentContact == null) {
		return;
	}
	var placeholder = $("#contact-prevpayments-info").empty();

	var arr = Caches.contributions.getLast(currentContact.id, 5, "receive_date");

	if (arr.length > 0) {
		$.each(arr, function (index, value) {
			placeholder.append("<div>"+value.financial_type+": " + value.total_amount + " (" + value.payment_instrument + ") "+ moment(value.receive_date).calendar() + "</div>");
		});
	} else {
		placeholder.append("<div>No previous payments</div>");
	}
}

function putLastParticipantsInPanel () {
	if (currentContact == null) {
		return;
	}
	var placeholder = $("#contact-prevevent-info").empty();

	var arr = Caches.participants.getLast(currentContact.id, 5, "participant_register_date", "participant_status_id", "2");

	if (arr.length > 0) {
		$.each(arr, function (index, value) {
			placeholder.append("<div>"+value.event_title+": "+value.participant_fee_amount + " " + moment(value.participant_register_date).calendar() + "</li>");
		});
	} else {
		placeholder.append("<div>No previous events</div>");
	}

}

function lock_uiobject (uiobject) {
	var current_locks = islocked_uiobject(uiobject);

	if (!current_locks) {
		uiobject.data('org.rks.doorsheet.lock', 1);
	} else {
		uiobject.data('org.rks.doorsheet.lock', current_locks++);
	}
	uiobject.prop("disabled", true);
}

/**
 * Check whether ther object is locked, returns the number of locks otherwise
 */
function islocked_uiobject (uiobject) {
	// should be unique (org.rks.doorsheet.lock)
	var current_var = parseInt(uiobject.data('org.rks.doorsheet.lock'));

	if (isNaN(current_var) || current_var == 0) {
		return false;
	}
	return current_var;
}

function unlock_uiobject (uiobject) {
	// should be unique (org.rks.doorsheet.lock)
	var current_locks = islocked_uiobject(uiobject);

	if (!current_locks) {
		print_error("BUG: Unlock called on object that is not locked");
		print_debug (uiobject);
		uiobject.data('org.rks.doorsheet.lock', 0);
		uiobject.prop("disabled", false);
		return false;
	}
	current_locks--;
	uiobject.data('org.rks.doorsheet.lock', current_locks);
	if (current_locks == 0) {
		uiobject.prop("disabled", false);
	} else if (current_locks < 0) {
		print_error("BUG: Unlocking beyond the lock number, you may be calling an unlock without a lock");
		uiobject.prop("disabled", false);
	} else {
		uiobject.prop("disabled", true);
	}
}

/**
 * @param dateObj
 * @param type
 * @return {String}
 */
function formatDate(dateObj, type) {
	//TODO: Convert this hideous thing to moment.js - moment.js already loaded!
	if (dateObj == "" || typeof dateObj == 'undefined')  {
		dateObj = moment();
	} else {
		dateObj = moment(dateObj);
	}

	switch (type) {	
	case "db":
	case "database":
		return dateObj.format("YYYY-MM-DD");
		break;
	case "db-time":
	case "database-time":
		//Beware of dragons - MM is month, mm is minute, SS is fractional second (0-100), ss is second (00-60)
		return dateObj.format("YYYY-MM-DD HH:mm:ss");
		break;
	case "datepicker":
		//Do it according to locale, set the datepicker locale to the same format
		return dateObj.format("L");
	default:
		//Return a relative date if possible
		return dateObj.calendar();
	break;
	}
}

/**
 * @param contactid
 * @return Array
 */
function getContact (id) {
	if (!Caches.contacts instanceof Cache) {
		print_error("BUG: We're calling getContact before having any cached contacts");
		return null;
	}
	var cacheObj = Caches.contacts.getContactId(id);
	if ($.isEmptyObject(cacheObj)) {
		print_error("Contact does not exist - refresh the page if this contact was recently created");
		return null;
	}
	return cacheObj;
}

/**
 * @param contactid
 */
function putMembershipsInPanel() {
	//Pull membership data
	if (Caches.contacts.data.length == 0 || Caches.memberships.data.length == 0) {
		setTimeout(putMembershipsInPanel, 250);
		return;
	}

	if (currentContact == null) {
		//No contact selected
		return;
	}

	var contact_id = currentContact.id;
	var contact = Caches.contacts.getContactId(contact_id);
	if ($.isEmptyObject(contact)) {
		print_error ("Contact not found");
		return;
	}

	//Remove previous info
	$("#membership-info").empty();
	$("#discountsAvailable").empty();
	$("#membership-info").append('<a href="https://crmv1.rochesterkinksociety.com/index.php?q=civicrm/contact/view&reset=1&cid='+contact_id+'" target="_blank">Contact ID: ' + contact_id + '</a><br>');
	$("#membership-info").removeClass().addClass("panel-body"); //Delete all the alert styles, restore panel-body
	$("body").removeClass();

	var memberships = Caches.memberships.getContactId(contact_id);
	var trialMemberInput = $("#membershipType input[value='" + trialMembershipId + "']");
	var membershipTypeInputs = $("#membershipType input");

	if (memberships.length > 0) {
		$.each(memberships, function (index, value) {
			currentContactMembership = value;
			print_debug ("Processing membership");
			//WARNING: Index is not an ID
			//TODO: membership_type_id should dynamically hide and show prices/permissions
			switch (parseInt(value["membership_type_id"])) {
			case 1:
				//Board
			case 2:
				//Gold
			case 7:
				//Honorary
				$("#membership-info").addClass("membership-gold");
				$.each(EventPanels, function (index, eventpanel) {
					eventpanel.setToFree();
				});
				break;
			case 3:
				//Standard
			case 8:
				//Staff
				$("#membership-info").addClass("membership-standard");
				$.each(EventPanels, function (index, eventpanel) {
					eventpanel.setToMemberPrice();
				});
				break;
			case 4:
				//Senior
				$("#membership-info").addClass("membership-senior");
				$.each(EventPanels, function (index, eventpanel) {
					eventpanel.setToDiscountPrice();
				});
				break;
			case 5:
				//Student
				$("#membership-info").addClass("membership-student");
				$.each(EventPanels, function (index, eventpanel) {
					eventpanel.setToDiscountPrice();
				});
				break;
			case 6:
				//Trial
				$("#membership-info").addClass("membership-trial");
				//Make sure to warn so we don't sign up guests
				$("#membership-info").addClass("attention-warning");
				$.each(EventPanels, function (index, eventpanel) {
					eventpanel.setToMemberPrice();
				});
				break;
			case 10:
				//Friend of RKS
			case 11:
				//OOA
				$("#membership-info").addClass("membership-ooa");
				$.each(EventPanels, function (index, eventpanel) {
					eventpanel.setToDiscountPrice();
				});
				break;
			case 12:
				//Hiatus
				$("#membership-info").addClass("attention-info");
				$.each(EventPanels, function (index, eventpanel) {
					eventpanel.setToGuestPrice();
				});
				break;
			default:
				//This is a non-standard membership type - flash attention info, set to member price 
				$("#membership-info").addClass("attention-info");
			$.each(EventPanels, function (index, eventpanel) {
				eventpanel.setToMemberPrice();
			});
			break;		
			}
			$("#membership-info").append("Type: " + value["membership_name"] + "<br>");
			$("#membership-info").append("Joined: " + moment(value["join_date"]).calendar() + "<br>");

			//TODO: Handle memberships without start/end date cleanly (Honorary)
			if (value["start_date"] == "" || value["end_date"] == "") {
				$("#membership-info").append("Lifetime membership");
			} else {
				$("#membership-info").append("Start Date: " + moment(value["start_date"]).calendar() + "<br>");
				var end_date = moment(value["end_date"]);
				if (end_date.isBefore()) {
					$("#membership-info").append("Membership Expired!<br>");
					$("#membership-info").addClass("attention-warning");
				} else if (moment().add('months', 1).isAfter(end_date)) {
					$("#membership-info").append("Membership will expire in 1 month or less!<br>");
					$("#membership-info").addClass("attention-info");
				}
				$("#membership-info").append("End Date: " + end_date.calendar() + "<br>");
			}

		});
		//Membership already exists, disable Trial Membership
		membershipTypeInputs.prop("disabled", false);
		trialMemberInput.prop("disabled", true);
		$("#membership-priceFields label[data-membershipcategory]").hide();
		var checkedType = $("#membershipType label[data-defaultmembership=1]").find("input").prop("checked", true).val();
		$("#membership-priceFields label[data-defaultmembership=1]").find("input").prop("checked", true);
		$("#membership-priceFields label[data-membershipcategory="+checkedType+"]").show();
	} else {
		//Membership doesn't exist yet, enable only Trial membership option
		$("#membership-info").append("No membership found<br>");
		membershipTypeInputs.prop("disabled", true);
		trialMemberInput.prop("disabled", false).prop("checked", true);
		$("#membershipType input[value='Special']").prop("disabled", false);
		$("#membership-priceFields label[data-membershipcategory]").hide();
		$("#membership-priceFields input[data-membership-type='" + trialMembershipId + "']").prop("checked", true);
		$("#membership-priceFields label[data-membershipcategory='" + trialMembershipId + "']").show();
		$.each(EventPanels, function (index, eventpanel) {
			eventpanel.setToGuestPrice();
		});
	}

	//Set the default price depending on membership type
	setMembershipPriceOnButton();

	if (contact.banned) {
		$("#membership-info").append("INDIVIDUAL NOT APPROVED!<br>");
		$("body").addClass("attention-danger");
	}
	if (!contact.guests) {
		$("#membership-info").append("NO GUESTS ALLOWED!<br>");
		$("body").addClass("attention-warning");
	}
	if (contact.credit) {
		$("#membership-info").append("Has $" + contact.credit + " credit<br>");
		$("#discountsAvailable").append("<label>Credit: <input type='number' name='credit' value='" + contact.credit + "' max='" + contact.credit + "' min='0'></label><br>");
	}
	if (contact.rbucks) {
		$("#membership-info").append("Has " + contact.rbucks + " RBucKS<br>");
		$("#discountsAvailable").append("<label>RBucKS:&nbsp;&nbsp;<input type='number' name='rbucks' value='0' max='" + contact.rbucks + "' min='0'></label><br>");
	} else {
		$("#membership-info").append("Has no RBucKS<br>");
		$("#discountsAvailable").append("Has no RBucKs<br>");
	}

	if (contact.guestpasses) {
		$("#membership-info").append("Has " + contact.guestpasses + " guest passes<br>");
		$("#discountsAvailable").append("<label>Guest Passes:&nbsp;&nbsp;<input type='number' name='guestpasses' value='0' max='" + contact.guestpasses + "' min='0'></label><br>");
	} else {
		$("#membership-info").append("Has no Guest Passes<br>");
		$("#discountsAvailable").append("Has no Guest Passes<br>");
	}

}

function validateEmail(email) {
	//TODO: validate this regexp against existing RFC's - should match 99.99% of e-mails though
	var regexp = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
	return regexp.test(email);
} 

/**
 * @param id
 * @param nickname
 * @param firstname
 * @param lastname
 * @param email
 */
function updateContact (id, nickname, firstname, lastname, email ) {
	var query = {};
	query.entity = "Contact";
	query.action = "create";
	if (parseInt(id) > 0) {
		query.id = id; //Create together with an ID updates the contact
		this.successMsg = "Successfully updated Contact";
		this.errorMsg = "Error updating Contact";
	} else {
		query.contact_type = "Individual"; //No ID was specified, Contact type is Individual
		this.successMsg = "Successfully created Contact";
		this.errorMsg = "Error creating Contact";
		if (Caches.contacts.getByEmail(email).length > 0) {
			if (!confirm("A contact with this e-mail address already exists, are you sure you want to continue?")) {
				print_error(this.errorMsg + ": Duplicate e-mail");
				return false;
			}
		}
		if (Caches.contacts.getByNickName(nickname).length > 0) {
			alert ("A contact with this scene name already exists; contact creation cancelled");
			print_error(this.errorMsg + ": Duplicate scene name");
			return false;
		}
	}
	query.nick_name = nickname;
	query.first_name = firstname;
	query.last_name = lastname;
	query.email = email;

	if (!validateEmail(email)) {
		print_error(this.errorMsg + ": Invalid e-mail address");
		return false;
	}

	$.ajax({
		url: CRMRESTURL,
		data: query,
		type: "POST",
		dataType: "json", //Don't forget to say this, it will fail otherwise
		context: this
	})
	.done(function (data, textStatus, jqXHR) {
		if (!test_apidata_error(data, this.successMsg, this.errorMsg)) {
			return false;
		}
		query.id = data.id;
		print_debug (query);
		logTransaction(query, textStatus);
		changeActiveContact(data.id);
	})
	.fail(function (jqXHR, textStatus, errorThrown) {
		print_error(this.errorMsg);
	});

}

//Date types should get a datepicker 
$('.date').datepicker({
	todayBtn: "linked",
	autoclose: true,
	todayHighlight: true
});

$('#contact-form').submit(function (event) {
	event.preventDefault();
	print_debug ("Contact change/create submitted");

	var nickname = $("#update-contact-nick_name").val();
	var email = $("#update-contact-email").val();
	var firstname = $("#update-contact-first_name").val();
	var lastname = $("#update-contact-last_name").val();
	var contact_id = $("#update-contact-id").val();

	updateContact(contact_id, nickname, firstname, lastname, email);

	$("#contact-modal").modal('hide');
});

$('#contact-create').click(function (event) {
	$("#update-contact-nick_name").val("");
	$("#update-contact-email").val("");
	$("#update-contact-first_name").val("");
	$("#update-contact-last_name").val("");
	$("#update-contact-id").val(0);
	$('#contact-modal .modal-title').text("Create new contact");
	$('#contact-modal').modal('show');
});

$('#contact-change').click(function (event) {
	var contact = currentContact;
	if (contact == null || contact.id == null) {
		print_error ("No contact loaded");
		return false;
	}
	$("#update-contact-nick_name").val(contact.nick_name);
	$("#update-contact-email").val(contact.email);
	$("#update-contact-first_name").val(contact.first_name);
	$("#update-contact-last_name").val(contact.last_name);
	$("#update-contact-id").val(contact.id);
	$('#contact-modal .modal-title').text("Update contact");
	$('#contact-modal').modal('show');
});

function EventPanel (event_id) {
	var context = this;

	this.setPrice = function (num) {
		context.currentPrice = num;
		context.eventPriceContainer.text(parseFloat(num).toFixed(2));
	};

	this.getPrice = function (num) {
		return context.currentPrice;
	};

	this.setToMemberPrice = function () {
		context.setPrice(context.defaultPrice);
		context.defaultPriceInput.prop('checked', true);
	};

	this.setToGuestPrice = function () {
		context.setPrice(context.guestPrice);
		context.guestPriceInput.prop('checked', true);
	};

	this.setToDiscountPrice = function () {
		context.setPrice(context.discountPrice);
		context.discountPriceInput.prop('checked', true);
	};

	this.setToFree = function () {
		context.setPrice(0);
		context.freePriceInput.prop('checked', true);
	};

	//Get the Event from the database
	this.event = Caches.events.data[event_id];
	//Get the PriceFieldValues associated with this Event ID
	var pricefieldvalues = Caches.pricefieldvalues.getEntity(event_id);


	var form = $('<form role="form" class="event-transaction" id="event-transaction-'+event_id+'">');

	//We want this form to be attached to the transaction-container
	$("#transaction-container").prepend(form);

	var panel = $('<div class="panel panel-default event-panel"></div>');
	form.append(panel);

	var paneltitle = $('<h2 class="panel-title">'+this.event.title+'</h2>');

	var panelhead = $('<div class="panel-heading"></div>');
	panelhead.append(paneltitle);

	var panelbody = $('<div class="panel-body"></div>');

	panel.append(panelhead);
	panel.append(panelbody);

	var row = $('<div class="row"></div>');
	var eventPriceOptionsContainer = $('<div class="col-md-8"></div>');
	var col_mid = $('<div class="col-md-2"></div>');
	var col_right = $('<div class="col-md-2"></div>');
	row.append(eventPriceOptionsContainer).append(col_mid).append(col_right);	
	panelbody.append(row);

	this.eventPriceContainer = $('<span class="badge" style="font-size: 28px;">0.00</span>');
	this.addButton = $('<button type="button" class="btn btn-default btn-success" name="event-add" data-target="transaction-info">Add</button>');
	this.addButton.click(function (e) {
		if (currentContact == null) {
			print_error("No contact selected");
			return false;
		}
		//Make sure we're not accidentally passing objects or strings 
		var price = parseFloat(context.currentPrice);
		if (isNaN(price)) {
			price = 0;
		}

		//Save this transaction into the local transaction list
		var passdata = {
				"price": price,
				"type": "event",
				"contactid": currentContact.id };
		passdata.fields = {};
		passdata.fields.participant_contact_id = currentContact.id;
		passdata.fields.contact_id = currentContact.id;
		passdata.fields.event_id = context.event.id;
		passdata.fields.participant_status_id = 2; //1 = Registered, 2 = Attended
		passdata.fields.participant_source = "Doorsheet Participant v"+version;
		passdata.fields.participant_register_date = formatDate("", "db-time");
		passdata.fields.participant_role_id = 1; //1 = Attendee
		passdata.fields.participant_fee_currency = "USD";

		StagedTransactions.add(passdata);
	});

	col_mid.append(this.eventPriceContainer);
	col_right.append(this.addButton);

	this.currentPrice = 0;

	this.defaultPrice = 0;
	this.discountPrice = 0;
	this.guestPrice = 0;

	//Set to a generic input object so it doesn't fail
	this.defaultPriceInput = $("<input>");
	this.freePriceInput = {};
	this.discountPriceInput = {};
	this.guestPriceInput = {};

	if (pricefieldvalues.length > 0) {
		for (var i = 0; i < pricefieldvalues.length; i++) {
			var price = pricefieldvalues[i];
			print_debug (price);
			var eventPriceInput = $('<input name="event-pricefield" type="radio" value="'+price.amount+'">');
			var eventPriceLabel = $('<label> '+price.label+'</label>');
			eventPriceLabel.prepend(eventPriceInput);
			eventPriceLabel.append('&nbsp;');
			eventPriceOptionsContainer.append(eventPriceLabel);
			if (price.is_default == "1") {
				this.defaultPrice = parseFloat(price.amount);
				this.defaultPriceInput = eventPriceInput;
				this.setPrice(this.defaultPrice);
				this.defaultPriceInput.prop('checked', true);
			} else if (price.label == "Guest") {
				this.guestPrice = parseFloat(price.amount);
				this.guestPriceInput = eventPriceInput;
			} else if (price.label == "Discount") {
				this.discountPrice = parseFloat(price.amount);
				this.discountPriceInput = eventPriceInput;
			}
			if (price.amount == 0) {
				this.freePriceInput = eventPriceInput;
			} 
			eventPriceInput.click(function (e) {
				context.setPrice($(this).val());
			});
		};
	} else {
		eventPriceOptionsContainer.append('No price set defined, click Add to register a participant');
	}
	if ($.isEmptyObject(this.discountPriceInput)) {
		this.discountPriceInput = this.defaultPriceInput;
		this.discountPrice = this.defaultPrice;
	}
	if ($.isEmptyObject(this.freePriceInput)) {
		this.freePriceInput = this.defaultPriceInput;
	}
	if ($.isEmptyObject(this.guestPriceInput)) {
		this.guestPriceInput = this.defaultPriceInput;
		this.guestPrice = this.defaultPrice;
	}
}

$("#show-transactions").click(function (event) {
	$("#main").hide();
	$("#reports-container").hide();
	$("#transactionlist-container").show();
});

function ProgressBar () {
	var context = this;
	context.meter = 0;
	context.container = $("#pleasewait-modal");
	context.progressbar = $('#pleasewait-progress');
	this.show = function () {
		context.container.modal('show');
	};
	this.hide = function () {
		var waits = 0;
		$.each(Caches, function (idx, cache) {
			//A user must have a membership in order for the Doorsheet to work!
			//There don't necessarily need to be participants or payments registered though.
			if (!(cache.entity == "Participant" || cache.entity == "ParticipantPayment" || cache.entity == "Contribution") && cache.data.length == 0) {
				print_debug ("Waiting for :" + cache.entity);
				waits++;
			}
		});
		if (waits > 0) {
			setTimeout(progressBar.hide, 250);
			return;
		}
		context.container.modal('hide');
	};
	this.get = function () {
		return context.meter;
	};
	this.set = function (percentage) {
		context.meter = percentage;
		context.progressbar.css('width', context.meter + '%');
		return context.meter;
	};
	this.reset = function() {
		context.meter = 0;
		context.set(0);
		return 0;
	};
	this.update = function (percentage) {
		context.meter += percentage;
		return context.set(context.meter);
	};
}

$("#show-main").click(function (event) {
	$("#main").show();
	$("#reports-container").hide();
	$("#transactionlist-container").hide();
});

$("#refresh-data").click(refreshCaches);

function refreshCaches() {
	var timeout = 0;
	progressBar.reset();
	progressBar.show();
	$.each(Caches, function (idx, cache) {
		cache.empty();
		setTimeout (function () {
			cache.fetch();
		}, timeout);
		timeout = timeout + ajaxdelay; //Wait n milliseconds before scheduling the next one
	});
	progressBar.hide();
}


$("#show-reports").click(function (event) {
	$("#main").hide();
	$("#reports-container").show();
	$("#transactionlist-container").hide();

	var loaded_events = $("#load-events-form input[name='event-id[]']:checked");
	if (loaded_events.length == 0) {
		print_error("You did not load any events, load an event, then click reporting again");
		return;
	}	

	//We just toggled it
	if ($("#reports-container").is(":visible") ) {
		refreshCaches();
		getReports();
	}
});

$("input[name='instrument-type']").click(function (event) {
	//Change of instrument type
	$("#submit-transaction").data("instrumentType", $(this).val());
});


$("#logout-user").click(logout_user);

$("#login-form").submit(function (event) {
	//Prevent reloading the page
	event.preventDefault();
	$("#btn-login").button('loading');
	//Hide the previous error message
	$("#login-error").hide().empty();
	$("#error").remove();

	//get the username and pass
	var username = $("#username").val();
	var password = $("#password").val();

	//The API key is the md5(username + password);
	var temp_key = CryptoJS.MD5(username.toLowerCase() + password);
	temp_key = temp_key.toString(CryptoJS.enc.Hex);

	login_user (username, temp_key);
});

$("#mail-report").click(function (event) {
	var query = {};
	var html = $("#reports-container");
	html.find("th").removeAttr('style').css("text-align", "left");
	query.subject = "Event Report";
	query.body = html.html();
	$.ajax({
		url: BaseURL + "/Doorsheet/mailer.php",
		dataType: "json", //Don't forget to say this, it will fail otherwise
		data: query,
	})
	.done(function (data, textStatus, jqXHR) {
		if (data) {
			print_success("Successfully sent report");
		} else {
			print_error ("Server error sending report " + data);
		}
	}).fail(function (jqXHR, textStatus, errorThrown) {
		print_error("Error sending report: " + textStatus + " - " + errorThrown);
	});
});

//Add discount
$("#discount-add").click(function (event) {
	//TODO: Make the credit types dynamic
	var data = {};
	data.type = "discount";
	data.contactid = currentContact.id;
	data.price = 0;
	data.fields = {};
	//Don't use parseInt because of rounding issues when adding int's and float's
	data.fields.credit = parseFloat($("#discount-panel").find("input[name='credit']").val());
	data.fields.rbucks = parseFloat($("#discount-panel").find("input[name='rbucks']").val());
	data.fields.guestpasses = parseFloat($("#discount-panel").find("input[name='guestpasses']").val());
	if (!isNaN(data.fields.credit) && data.fields.credit > 0) {
		data.price = data.price - data.fields.credit;
	} else {
		delete data.fields.credit;
	}

	if (!isNaN(data.fields.rbucks) && data.fields.rbucks > 0) {
		data.price = data.price - data.fields.rbucks;
	} else {
		delete data.fields.rbucks;
	}

	if (!isNaN(data.fields.guestpasses) && data.fields.guestpasses > 0) {
		var lrgGuestPrice = 0;
		$.each (EventPanels, function (index, eventpanel) {
			if (eventpanel.guestPrice > lrgGuestPrice) {
				lrgGuestPrice = eventpanel.guestPrice;
			}
		});
		data.price = data.price - (data.fields.guestpasses * lrgGuestPrice);
	} else {
		delete data.fields.guestpasses;
	}

	StagedTransactions.add(data);
});

//Reserve discount
$("#reserve-add").click(function (event) {
	print_error("Reserving for other transaction not implemented yet - add the discount to this transaction");
});

$("#cancel-transaction").click(StagedTransactions.clear);

$("#submit-transaction").click(function (event) {
	submitTransaction($(this).data());
});
