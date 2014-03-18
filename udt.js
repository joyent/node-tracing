// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var assert = require('assert');
var util = require('util');
var EventEmitter = require('events');
var PlatformProvider, platformProvider, dtraceProbe;

try {
  var PROBE_ARGUMENT_MAP = process.binding('dtrace').constants;
} catch(e) {
  var PROBE_ARGUMENT_MAP = {
    STRING: 1,
    JSON: 2,
    INT64: 3,
    UINT32: 4,
    INT32: 5,
    UINT16: 6,
    INT16: 7,
    UINT8: 8,
    INT8: 9
  } 
}

PROBE_ARGUMENT_MAP['CHAR *'] = PROBE_ARGUMENT_MAP.STRING;

for (var argname in PROBE_ARGUMENT_MAP) {
  PROBE_ARGUMENT_MAP[argname.toLowerCase()] = PROBE_ARGUMENT_MAP[argname];
  PROBE_ARGUMENT_MAP[PROBE_ARGUMENT_MAP[argname]] = argname.toLowerCase();
}

PROBE_ARGUMENT_MAP.INT = PROBE_ARGUMENT_MAP.INT64;
PROBE_ARGUMENT_MAP.int = PROBE_ARGUMENT_MAP.INT64;

var listenerCache = {};

function getListeners(namespace, module, probe) {
  var callbacks = [];

  Object.keys(listenerCache).forEach(function(namespaceKey) {
    if (namespaceKey !== namespace && namespaceKey !== '*')
      return;

    namespace = listenerCache[namespaceKey];

    Object.keys(namespace).forEach(function(moduleKey) {
      if (moduleKey !== module && moduleKey !== '*')
        return;

      var m = namespace[moduleKey];

      Object.keys(m).forEach(function(probeKey) {
        if (probeKey !== probe && probeKey !== '*')
          return;

        Object.keys(m[probeKey]).forEach(function(funcKey) {
          callbacks.push(m[probeKey][funcKey]);
        });
      });
    });
  });

  return callbacks;
}

function Probe(provider, name, signature) {
  if (!(this instanceof Probe))
    return new Probe(provider, name, signature);

  this.provider = provider;
  this.name = name;
  this.signature = signature;
  this.info = {
    namespace: provider.namespace,
    name: provider.name,
    probe: name
  };
}

Probe.prototype.fire = function(fargs, callback) {
  this.provider._throwDisabled('fire', this.name);

  var info = this.info;

  var namespace = info.namespace;
  var provider = info.name;

  var listeners = getListeners(namespace, provider, this.name);

  // We have no one listening for this event don't marshal arguments
  if (!this.binding && !listeners.length) {
    return;
  }

  var args;

  if (!util.isFunction(callback)) {
    callback = fargs;
    fargs = [];
  }

  if (!util.isFunction(callback))
    callback = function() { return []; };

  if (!util.isArray(fargs))
    fargs = [fargs];

  // we are either calling a JS or C++ function, but we only want to call the
  // provided marshalling callback once per firing, so cache those results.
  // event handlers could potentially muck with this array, and mess up
  // subsequent handlers, they shouldn't do that.
  args = callback(fargs);

  if (this.binding)
    this.binding(args);

  var i = 0;

  for (i = 0; i < listeners.length; i++) {
    var f = listeners[i];
    f(args, info);
  }
};

function Provider(options) {
  if (!(this instanceof Provider))
    return new Provider(options);

  this.namespace = options.namespace;
  this.name = options.name;
  this.enabled = false;
  this.probes = {};
}

Provider.prototype.enable = function() {
  this.enabled = true;
};

Provider.prototype.disable = function() {
  this.enabled = false;
};

Provider.prototype._signatureEqual = function(a, b) {
  return true;
};

Provider.prototype._probeFormat = function(name) {
  return util.format('%s:%s:%s', this.namespace, this.name, name);
};

Provider.prototype._getProbe = function(name) {
  return this.probes[name];
};

Provider.prototype._addProbe = function(probe) {
  this.probes[probe.name] = probe;
};

Provider.prototype._verifySignature = function(probe, signature) {
  // TODO(tjfontaine) should this be deferred until enable()?
  if (this.enabled && probe &&
      !this._signatureEqual(probe.signature, signature)) {
    var msg = 'Probe %s:%s enabled with signature %j, new signature: %j';
    msg = util.format(msg, this.name, name, probe.signature, signature);
    throw new Error(msg);
  }
};

Provider.prototype.addProbe = function(name, signature/*[, arg2, arg3]*/) {
  var probe = this._getProbe(name);

  if (!util.isArray(signature))
    signature = Array.prototype.slice.call(arguments, 1);

  this._verifySignature(probe, signature);

  if (!probe) {
    probe = new Probe(this, name, signature);
    this._addProbe(probe);
  }

  return probe;
};

Provider.prototype.removeProbe = function(name) {
  this._throwDisabled('remove', name);
  delete this.probes[name];
};

Provider.prototype._throwDisabled = function(action, name) {
  if (!this.enabled) {
    var msg = util.format('Cannot %s probe %s while disabled',
                          action,
                          this._probeFormat(name));
    throw new Error(msg);
  }
  return true;
};

Provider.prototype.fire = function(name, fargs, callback) {
  var probe = this.probes[name];

  if (!probe)
    return;

  probe.fire(fargs, callback);
};

function StaticProvider(name) {
  Provider.call(this, {
    namespace: 'node',
    name: name
  });
}
util.inherits(StaticProvider, Provider);

StaticProvider.prototype.addProbe = function(name, signature, binding) {
  var probe = Provider.prototype.addProbe.call(this, name, signature);
  probe.binding = binding;
  return probe;
};

StaticProvider.prototype.enable = function() {
  this.enabled = true;
};

function DTraceProbe(provider, name, signature, handle) {
  if (!(this instanceof DTraceProbe))
    return new DTraceProbe(provider, name, signature, handle);

  Probe.call(this, provider, name, signature);

  var mappedSignature = new Array(signature.length);

  for (var i = 0; i < signature.length; i++) {
    var originalType = signature[i];
    var mappedType = PROBE_ARGUMENT_MAP[originalType];

    if (!mappedType)
      throw new TypeError(util.format('%s is not a valid type', originalType));

    mappedSignature[i] = mappedType;
  }

  this.dprobe = new dtraceProbe(name, mappedSignature);
  handle.addProbe(this.dprobe);
}
util.inherits(DTraceProbe, Probe);

DTraceProbe.prototype.binding = function(args) {
  this.dprobe.fire(args);
};

function DTraceProvider(options) {
  Provider.call(this, options);

  this._handle = new platformProvider(options.namespace, options.name);
}
util.inherits(DTraceProvider, Provider);

DTraceProvider.prototype.addProbe = function(name, signature) {
  var probe = this._getProbe(name);

  if (!util.isArray(signature))
    signature = Array.prototype.slice.call(arguments, 1);

  this._verifySignature(probe, signature);

  var probe = new DTraceProbe(this, name, signature, this._handle);

  this._addProbe(probe);

  return probe;
};

DTraceProvider.prototype.removeProbe = function(name) {
  var probe = this.probes[name];

  probe.binding = null;
  var dprobe = probe.dprobe;
  delete probe.dprobe;
  this._handle.removeProbe(dprobe);

  Provider.prototype.removeProbe.call(this, name);
};

DTraceProvider.prototype.enable = function() {
  Provider.prototype.enable.call(this);
  return this._handle.enable();
};

DTraceProvider.prototype.disable = function() {
  Provider.prototype.disable.call(this);
  return this._handle.disable();
};

var namespaces = {};

function _registerProvider(provider) {
  var providers = namespaces[provider.namespace];

  if (!providers)
    providers = namespaces[provider.namespace] = {};

  delete providers[provider.name];

  providers[provider.name] = provider;
}

function _makeProviderOptions(options) {
  if (util.isString(options)) {
    options = {
      namespace: options,
      name: options
    };
  }
  return options;
}

exports.createProvider = function(options) {
  if (!PlatformProvider) {
    if (process.config.variables.node_use_dtrace) {
      try {
        platformProvider = process.binding('dtrace_provider').DTraceProvider;
        dtraceProbe = process.binding('dtrace_provider').DTraceProbe;
        PlatformProvider = DTraceProvider;
      } catch(e) {
        PlatformProvider = Provider;
      }
    } else {
      PlatformProvider = Provider;
    }
  }

  options = _makeProviderOptions(options);

  if (options.namespace === 'node') {
    throw new Error(util.format(
        'Cannot create provider %s in the node namespace',
        options.name));
  }

  var m = exports.getProvider(options);

  if (!m) {
    m = new PlatformProvider(options);
    _registerProvider(m);
  }

  return m;
};

exports.getProvider = function(options) {
  options = _makeProviderOptions(options);

  var namespace = namespaces[options.namespace];

  if (!namespace) return;

  return namespace[options.name];
};

exports.list = function() {
  var ret = {};
  Object.keys(namespaces).forEach(function(namespace) {
    var ns = ret[namespace] = {};
    namespace = namespaces[namespace];
    Object.keys(namespace).forEach(function(provider) {
      var ps = ns[provider] = {};
      provider = namespace[provider];
      Object.keys(provider.probes).forEach(function(probe) {
        var p = ps[probe] = {};
        probe = provider.probes[probe];
        p.signature = probe.signature;
      });
    });
  });
  return ret;
};

function getListenerCache(namespace, module, probe) {
  var lNamespace = listenerCache[namespace] = listenerCache[namespace] || {};
  var lModule = lNamespace[module] = lNamespace[module] || {};
  var lCb = lModule[probe] = lModule[probe] || {};
  return lCb;
}

exports.on = function(namespace, module, probe, cb) {
  var lCb = getListenerCache(namespace, module, probe)[cb] = cb;
};

exports.removeListener = function(module, probe, cb) {
  var lCb = getListenerCache(namespace, module, probe);

  if (lCb)
    delete lCb[cb];
};
