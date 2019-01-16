var request = require('request');

var auth = require('./auth');
var config = require('./config').obtain();
var dwjson = require('./dwjson').init();
var job = require('./job');
var console = require('./log');
var ocapi = require('./ocapi');
var webdav = require('./webdav');

const ENDPOINT_META = '/s/-/dw/meta/v1/rest';

/**
 * Adds the passed host to the list of instances used with the CLI. If parameter
 * alias was passed, the CLI is able to lookup the instance using this alias for any instance
 * specific command.
 *
 * @param {String} host the host name of the instance to add
 * @param {String} alias the alias for the instance to add
 * @param {Boolean} asDefault set instance as new default, false by default
 */
function add(host, alias, asDefault) {
    // build the request options
    var options = ocapi.getOptions(host, ENDPOINT_META, null);

    // just do the request and pass the callback
    request.get(options, function (err, res) {
        if (res && res.statusCode != 404) {
            // persist the instance
            addInstance(host, alias);
            console.info('Instance configuration updated');
            // set it as new default
            if (asDefault) {
                setInstance(host);
            } else if ( getAllInstances().length === 1 && !config.get('default_instance') ) {
                // set as default, if its the first instance and no default set yet
                setInstance(host);
            }
        } else {
            console.error('Adding instance %s failed: %s', host, err);
        }
    });
}

/**
 * TODO Hardening this as it is returning an unexisting instance if nothing found
 *
 * @param {String} aliasOrHost alias or host name of the instance to return
 * @return {String} the instance being determined
 */
function getInstance(aliasOrHost) {
    // in case aliasOrHost wasn't passed
    if (!aliasOrHost) {
        // check for default instance and return this
        if ( config.get('default_instance') ) {
            return config.get('default_instance');
        }

        // or check for an instance in a dw.json file
        if ( dwjson['hostname'] ) {
            return dwjson['hostname'];
        }

        return null;
    }
    // attempt to lookup instance
    var instance = lookupInstance(aliasOrHost);
    if (instance) {
        return instance;
    }

    // otherwise just return the aliasOrHost assuming it is an unconfigured host
    return aliasOrHost;
}

/**
 * Utility function to lookup an instance host name by its alias or host. Will search within
 * the list of configured instances.
 *
 * @param {String} aliasOrHost the alias or host of the instance to look up
 * @return {String} the instance host name being determined, or null if host is not configured
 */
function lookupInstance(aliasOrHost) {
    var all = getAllInstances();
    for (var i=0; i<all.length; i++) {
        if (all[i].alias === aliasOrHost || all[i].instance === aliasOrHost) {
            return all[i].instance;
        }
    }
    return null;
}

/**
 * Sets the passed host as the default instance used with the CLI.
 *
 * @param {String} host the host of the instance to set as default
 */
function setInstance(host) {
    config.set('default_instance', host);
    console.info('Instance %s set as default.', host);
}

/**
 * Adds the passed instance to the list of instances used with the CLI. If parameter
 * alias was passed, the CLI is able to lookup the instance using this alias for any instance
 * specific command.
 *
 * @param {String} instance the instance to add to the list
 * @param {String} alias the alias to use for this instance
 */
function addInstance(instance, alias) {
    // get the persisted list of instances
    var instances = config.get('instances');
    if ( !Array.isArray(instances) ) {
        instances = [];
    }
    // search for a duplicate (by instance only)
    var instanceDuplicates = instances.filter(function(i) {
        return ( i.instance === instance );
    });
    // do not allow duplicate instances
    if ( instanceDuplicates.length > 0 ) {
        console.warn('Instance %s already defined. Skipping.', instance);
        return;
    }

    if (alias) {
        // search for a duplicate (by alias only)
        var aliasDuplicates = instances.filter(function(i) {
            return ( i.alias === alias );
        });
        // do not allow duplicate alias
        if ( aliasDuplicates.length > 0 ) {
            // null alias
            instances.forEach(function(i) {
                if ( i['alias'] === alias ) {
                    i['alias'] = null;
                }
            });

            console.info('Alias "%s" already in use. Alias reset and set for new instance %s.', alias, instance);
        }
    }

    // add the brand new instance
    instances.push({ alias : ( alias ? alias : null ), instance : instance });
    // persist
    config.set('instances', instances);
}

/**
 * Returns all instances currently configured with the CLI.
 *
 * @return {Object[]} an array containing all instances
 */
function getAllInstances() {
    // get the persisted list of instances
    var instances = config.get('instances');
    if ( !Array.isArray(instances) ) {
        return [];
    }
    // extend with default property
    instances.forEach(function(i) {
        i['default'] = ( getInstance() === i['instance'] ? true : false );
    });
    return instances;
}

/**
 * List details of all instances currently configured and renders them to the console.
 *
 * @param {Boolean} verbose return more, detailed information
 * @param {Boolean} asJson format output as json
 * @param {String} sortBy the field to sort code versions by
 */
function list(verbose, asJson, sortBy) {
    var data = { auth : { client_id : auth.getClient() }, default_instance : getInstance() };

    // client details
    var out = [['Client ID', ( auth.getClient() ? auth.getClient() : '(not set)' )]];
    if (verbose) {
        data['auth']['access_token'] = auth.getToken();
        data['auth']['auto_renew_token'] = auth.getAutoRenewToken();

        out.push(['Oauth Token', ( auth.getToken() ? '(set)' : '(not set)' )]);
        out.push(['Auto Renew Token', ( auth.getAutoRenewToken() ? 'Yes' : 'No' )]);
    }
    out.push(['Default Instance', ( getInstance() ? getInstance() : '(not set)' )]);

    // append if to be formatted as json
    if (!asJson) {
        console.table(out);
    }

    // instance details
    var out = [['Alias','Instance','Default']];
    var list = getAllInstances();

    // apply sorting
    if (sortBy) {
        list = require('./json').sort(list, sortBy);
    }

    // append and render all as json
    if (asJson) {
        data['instances'] = list;
        console.log(JSON.stringify(data));
        return;
    }

    if (list.length == 0) {
        out.push(['(not set)','(not set)','(not set)']);
    }
    for (var i of list) {
        out.push([i.alias,i.instance,( i.default ? 'Yes' : '' )]);
    }

    console.table(out);
}

function clearAll() {
    config.delete('instances');
    config.delete('default_instance');
    console.info('Instance configuration cleared.');
}

function runImport(instance, file_name, asJson) {
    job.run(instance, 'sfcc-site-archive-import', {
        file_name : file_name
    }, asJson);
}

function runImportSync(instance, file_name, asJson, failFast) {
    job.runSync(instance, 'sfcc-site-archive-import', {
        file_name : file_name
    }, asJson, failFast);
}

function saveState(instance) {
    job.run(instance, 'sfcc-save-instance-state', null);
}

function saveStateSync(instance) {
    job.runSync(instance, 'sfcc-save-instance-state', null);
}

function resetState(instance) {
    job.run(instance, 'sfcc-reset-instance-state', null);
}

function resetStateSync(instance) {
    job.runSync(instance, 'sfcc-reset-instance-state', null);
}

module.exports.add = add;
module.exports.getInstance = getInstance;
module.exports.list = list;
module.exports.clearAll = clearAll;
module.exports.saveState = saveState;
module.exports.saveStateSync = saveStateSync;
module.exports.resetState = resetState;
module.exports.resetStateSync = resetStateSync;
module.exports.import = runImport;
module.exports.importSync = runImportSync;
module.exports.api = {
    /**
     * Uploads an instance import file onto a Commerce Cloud instance.
     *
     * @param {String} instance The instance to upload the import file to
     * @param {String} file The file to upload
     * @param {String} token The Oauth token to use for authentication
     * @param {Object} options The options parameter can contains two properties: pfx: the path to the client certificate to use for two factor authentication. passphrase: the optional passphrase to use with the client certificate
     * @param {Function} callback Callback function executed as a result. The error will be passed as parameter to the callback function.
     */
    upload : function (instance, file, token, options, callback) {
        webdav.api.upload(instance, webdav.WEBDAV_INSTANCE_IMPEX, file, token, options, callback);
    },

    /**
     * Perform an instance import (aka site import) on a Commerce Cloud instance. You may use
     * the API function job.status to get the execution status of the import.
     *
     * @param {String} instance Instance to start the import on
     * @param {String} file_name The import file to run the import with
     * @param {String} token The Oauth token to use for authentication
     * @param {Function} success Callback function executed as a result. The job execution details and the error will be passed as parameters to the callback function.
     */
    import : function (instance, file_name, token, callback) {
        job.api.run(instance, 'sfcc-site-archive-import', { file_name: file_name }, token, function (err, res) {
            ocapi.ensureValidToken(err, res, function(err, res) {
                if (!err && ( res.statusCode == 200 || res.statusCode == 202 ) && !res.fault) {
                    // if successful, callback with execution details
                    callback(res.body, undefined);
                    return;
                }

                // Handle Errors
                if (res.text) {
                    callback(JSON.parse(res.text), err);
                } else {
                    callback(undefined, err);
                }

                return;
            });
        });
    }
};
module.exports.cli = {
    /**
     * Sets the instance identified by aliasOrHost as new default instance.
     *
     * @param {String} aliasOrHost alias or host name of the instance to set as default
     * @param {Function} callback callback function, gets the error passed as only parameter
     */
    setDefault : function(aliasOrHost) {
        // try to lookup host
        var host = lookupInstance(aliasOrHost);
        // if host was found
        if (host) {
            setInstance(host);
            return;
        }
        // host not found
        console.error('Cannot set unknown "%s" as default instance.', aliasOrHost);
    }
};