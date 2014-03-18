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

var EventEmitter = require('events');


/* --- AsyncListener --- */

// Keep the stack of all contexts that have been loaded in the execution
// chain of asynchronous events.
var contextStack = [];
// The context (i.e. "this") that has been loaded before the user-defined
// callback is fired.
var activeContext;

// Incremental uid for new AsyncListener instances. The uid is used as a
// unique storage location for any data returned from an AsyncListener
// to a given context. Which is stored on the _asyncData property.
var alUid = 0;

// Stateful flags shared with Environment for quick JS/C++ communication.
// This object communicates the following things:
//
//  - kActiveAsyncContext: The ASYNC_PROVIDERS type of the activeContext.
//
//  - kActiveAsyncQueueLength: The length of the context's _asyncQueue.
//
//  - kWatchedProviders: Bitmasks specifying which ASYNC_PROVIDERS are
//    currently being listened for. This value is accumulated on the
//    activeContext._asyncWatchedProviders property.
var asyncFlags = {};

process.binding('async_listener').setupAsyncListener(asyncFlags,
                                                     runAsyncQueue,
                                                     loadAsyncQueue,
                                                     unloadAsyncQueue,
                                                     errorHandler);

// Must be the same as Environment::AsyncListener::Fields in src/env.h.
var kActiveAsyncContext = 0;
var kActiveAsyncQueueLength = 1;
var kWatchedProviders = 2;

// Prevent accidentally suppressing errors from create/before/after
// callbacks by toggling that they are being processed.
var inAsyncTick = false;

// To prevent infinite recursion when an error handler also throws.
var inErrorTick = false;

// Flags to determine what AsyncListener callbacks are available. These
// are set on individual AsyncListener instances, then accumulated on the
// context object for quick check in each load/unload/error phase.
var HAS_NONE_AL = 0;
var HAS_CREATE_AL = 1 << 0;
var HAS_BEFORE_AL = 1 << 1;
var HAS_AFTER_AL = 1 << 2;
var HAS_ERROR_AL = 1 << 3;

// Providers that users can watch for. The ASYNC_PROVIDERS names have been
// simplified from what's located in src/async-wrap.h.
var ASYNC_PROVIDERS = {
  // NEXTTICK is not located in async-wrap.h because it is a JavaScript
  // exclusive execution context. This will always fire on all callbacks
  // because it is currently impossible to determine the appropriate
  // provider for the nextTick() call site.
  NEXTTICK: -1,
  NONE: 0,
  CRYPTO: 1 << 0,
  FSEVENT: 1 << 1,
  FS: 1 << 2,
  GETADDRINFO: 1 << 3,
  PIPE: 1 << 4,
  PROCESS: 1 << 5,
  QUERY: 1 << 6,
  SHUTDOWN: 1 << 7,
  SIGNAL: 1 << 8,
  STATWATCHER: 1 << 9,
  TCP: 1 << 10,
  TIMER: 1 << 11,
  TLS: 1 << 12,
  TTY: 1 << 13,
  UDP: 1 << 14,
  ZLIB: 1 << 15
};

// Build a named map for all providers that are passed to create().
var PROVIDER_MAP = {};
for (var i in ASYNC_PROVIDERS)
  PROVIDER_MAP[ASYNC_PROVIDERS[i]] = i;


// Public API.
exports.createAsyncListener = createAsyncListener;
exports.addAsyncListener = addAsyncListener;
exports.removeAsyncListener = removeAsyncListener;
exports.ASYNC_PROVIDERS = ASYNC_PROVIDERS;


// TODO(trevnorris): Move everything off _async* to a single _async Object
// where all the other properties are stored. This way the context is given
// as few extra properties as possible!!!!!!


function resetGlobalContext() {
  // All the values here are explained in runAsyncQueue().
  activeContext = {
    // _asyncData is a sparse array. Do NOT change to basic bracket notation.
    _asyncData: new Array(),
    _asyncQueue: [],
    _asyncWatchedProviders: ASYNC_PROVIDERS.NONE,
    _asyncProvider: 0,
    _asyncCallbackFlags: HAS_NONE_AL
  }
}
// Initialize the global context.
resetGlobalContext();


// Run all the async listeners attached when an asynchronous event is
// instantiated.
function runAsyncQueue(ctx, provider) {
/* debug:start */
// XXX: These should not be reachable. Remove before commit.
if (activeContext._asyncQueue.length === 0) {
  process.abort();
  //throw new Error('activeContext._asyncQueue has no items to process');
}
/* debug:stop */
  // data is a sparse array. Do NOT change to basic bracket notation.
  var data = new Array();
  var queue = [];
  var providerType = PROVIDER_MAP[provider];
  var acQueue = activeContext._asyncQueue;
  var i, item, queueItem, value;

  // Array of all AsyncListeners attached to this context.
  ctx._asyncQueue = queue;
  // Object containing passed or returned storageData. The storage index
  // is the same as the AsyncListener instance's uid. If the AsyncListener
  // was set then the value will at least be null. Which means a quick
  // check can be made to see if the AsyncListener exists by checking if
  // the value is undefined.
  ctx._asyncData = data;
  // Attach the numeric ASYNC_PROVIDERS type to set kActiveAsyncContext
  // when an activeContext is loaded.
  ctx._asyncProvider = provider;
  // Specify flags identifying the cumulate of callbacks for all
  // AsyncListeners in the attached _asyncQueue.
  ctx._asyncCallbackFlags = activeContext._asyncCallbackFlags;
  // The cumulate of all watched providers from all AsyncListeners in
  // the _asyncQueue.
  ctx._asyncWatchedProviders = 0;

  inAsyncTick = true;

  // Regardless whether this context's provider type is being listened for
  // or not, always iterate through the loop and attach the appropriate
  // values to the context.
  for (i = 0; i < acQueue.length; i++) {
    queueItem = acQueue[i];
    queue.push(queueItem);
    ctx._asyncWatchedProviders |= queueItem.watched_providers;
    // Check if the queueItem has a create() callback.
    if ((queueItem.callback_flags & HAS_CREATE_AL) === 0 ||
        // Check if this provider is being watched.
        (provider & queueItem.watched_providers) === 0) {
      data[queueItem.uid] = queueItem.data;
      continue;
    }
    // Run the create() callback and overwrite the default userData if
    // a value was returned.
    value = queueItem.create(queueItem.data, providerType);
    data[queueItem.uid] = (value === undefined) ? queueItem.data : value;
  }
  inAsyncTick = false;
}


// Load the passed context as the new activeContext, and place the
// current activeContext in the contextStack.
function loadContext(ctx) {
  if (!ctx._asyncQueue)
    return;
  contextStack.push(activeContext);
  activeContext = ctx;

  asyncFlags[kActiveAsyncContext] = ctx._asyncProvider;
  asyncFlags[kWatchedProviders] = ctx._asyncWatchedProviders;
  asyncFlags[kActiveAsyncQueueLength] = ctx._asyncQueue.length;
}


// Unload an activeContext after callbacks have run.
function unloadContext() {
  // If the contextStack has nothing in it then the activeContext is the
  // global context. It should then be reset back to initial state.
  if (contextStack.length > 0)
    activeContext = contextStack.pop();
  else
    resetGlobalContext();

  asyncFlags[kActiveAsyncContext] = activeContext._asyncProvider;
  asyncFlags[kActiveAsyncQueueLength] = activeContext._asyncQueue.length;
  asyncFlags[kWatchedProviders] = activeContext._asyncWatchedProviders;
}


// Add the passed context to the contextStack.
function loadAsyncQueue(ctx) {
  // There are specific cases where changing the async_flags_ value is
  // currently impossible (e.g. TimerWrap). In those cases go ahead and
  // return early if this was called with nothing in _asyncQueue.
  if (ctx._asyncQueue && ctx._asyncQueue.length === 0)
    return;

  loadContext(ctx);

  // Check if this provider type is being watched or if there are any
  // before() callbacks.
  if ((ctx._asyncProvider & ctx._asyncWatchedProviders) === 0 ||
      (ctx._asyncCallbackFlags & HAS_BEFORE_AL) === 0)
    return;

  var queue = ctx._asyncQueue;
  var data = ctx._asyncData;
  var i, queueItem;

  inAsyncTick = true;
  for (i = 0; i < queue.length; i++) {
    queueItem = queue[i];
    // Check if this provider type is being watched or if it has any
    // before() callbacks.
    if ((ctx._asyncProvider & queueItem.watched_providers) !== 0 &&
        (queueItem.callback_flags & HAS_BEFORE_AL) !== 0)
      queueItem.before(ctx, data[queueItem.uid]);
  }
  inAsyncTick = false;
}


// Remove the passed context from the contextStack.
function unloadAsyncQueue(ctx) {
  // Check if this provider type is being watched or if there are any
  // after() callbacks. There is also the case where all items in the
  // _asyncQueue were removed, but that will be handled by these checks.
  if ((ctx._asyncProvider & ctx._asyncWatchedProviders) === 0 ||
      // Check if any AsyncListeners have an after() callback.
      (ctx._asyncCallbackFlags & HAS_AFTER_AL) === 0) {
    unloadContext();
    return;
  }

  var queue = ctx._asyncQueue;
  var data = ctx._asyncData;
  var i, queueItem;

  inAsyncTick = true;
  for (i = 0; i < queue.length; i++) {
    queueItem = queue[i];
    // Check if this provider type is being watched or if it has any
    // after() callbacks.
    if ((ctx._asyncProvider & queueItem.watched_providers) !== 0 &&
        (queueItem.callback_flags & HAS_AFTER_AL) !== 0)
      queueItem.after(ctx, data[queueItem.uid]);
  }
  inAsyncTick = false;

  unloadContext();
}


// This will always be called first from _fatalException. If the activeContext
// has any error handlers then trigger those and check if "true" was
// returned to indicate the error was handled.
//
// The error() callback is unique because it will always fire in any tracked
// call stack regardless whether the provider of the context matches the
// providers being watched.
function errorHandler(er) {
  if (inErrorTick || (activeContext._asyncCallbackFlags & HAS_ERROR_AL) === 0)
    return false;

  var handled = false;
  var ac = activeContext;
  var data = ac._asyncData;
  var queue = ac._asyncQueue;
  var i, queueItem, threw;

  inErrorTick = true;
  for (i = 0; i < queue.length; i++) {
    queueItem = queue[i];
    // Check if the AsyncListener has an error callback.
    if ((queueItem.callback_flags & HAS_ERROR_AL) === 0)
      continue;
    try {
      threw = true;
      handled = queueItem.error(ac, data[queueItem.uid], er) || handled;
      threw = false;
    } finally {
      // Die quickly if the error callback threw. Only allow exit events
      // to be processed.
      if (threw) {
        process._exiting = true;
        process.emit('exit', 1);
      }
    }
  }
  inErrorTick = false;

  unloadContext();

  // TODO(trevnorris): If the error was handled, should the after callbacks
  // be fired anyways?

  return handled && !inAsyncTick;
}


// Instance function of an AsyncListener object.
function AsyncListener(callbacks, data, provider) {
  if (typeof callbacks.create === 'function') {
    this.create = callbacks.create;
    this.callback_flags |= HAS_CREATE_AL;
  }
  if (typeof callbacks.before === 'function') {
    this.before = callbacks.before;
    this.callback_flags |= HAS_BEFORE_AL;
  }
  if (typeof callbacks.after === 'function') {
    this.after = callbacks.after;
    this.callback_flags |= HAS_AFTER_AL;
  }
  if (typeof callbacks.error === 'function') {
    this.error = callbacks.error;
    this.callback_flags |= HAS_ERROR_AL;
  }

  this.uid = ++alUid;
  this.data = data === undefined ? null : data;
  this.watched_providers = provider === undefined ? 0xfffffff : provider >>> 0;
}
// Not sure which callbacks will be set, so pre-define all of them.
AsyncListener.prototype.create = undefined;
AsyncListener.prototype.before = undefined;
AsyncListener.prototype.after = undefined;
AsyncListener.prototype.error = undefined;
// Track if this instance has create/before/after/error callbacks.
AsyncListener.prototype.callback_flags = HAS_NONE_AL;


// Create new AsyncListener, but don't add it to the activeContext's
// _asyncQueue.
//
// TODO(trevnorris): If an AL is passed, should a new instance be created
// with the new data and provider information?
function createAsyncListener(callbacks, data, providers) {
  if (callbacks instanceof AsyncListener)
    return callbacks;

  if (typeof callbacks !== 'object' || callbacks === null)
    throw new TypeError('Missing expected callbacks object');

  return new AsyncListener(callbacks, data, providers);
}


// Add a listener to the activeContext.
function addAsyncListener(callbacks, data, providers) {
  if (!(callbacks instanceof AsyncListener))
    callbacks = createAsyncListener(callbacks, data, providers);

  // userData values === undefiend mean the AsyncListener does not exist
  // in the _asyncQueue.
  if (activeContext._asyncData[callbacks.uid] === undefined) {
    addListenerQueueItem(callbacks);

    // Update Environment::AsyncListener flags.
    asyncFlags[kWatchedProviders] = activeContext._asyncWatchedProviders;
    asyncFlags[kActiveAsyncQueueLength] = activeContext._asyncQueue.length;
  }

  return callbacks;
}


function addListenerQueueItem(al) {
  activeContext._asyncQueue.push(al);
  activeContext._asyncData[al.uid] = al.data;
  activeContext._asyncCallbackFlags |= al.callback_flags;
  activeContext._asyncWatchedProviders |= al.watched_providers;
}


// Remove the AsyncListener from the stack.
function removeAsyncListener(al) {
  if (!(al instanceof AsyncListener))
    throw new TypeError('argument should be instance of AsyncListener');

  removeAL(activeContext, al);

  // Update Environment::AsyncListener flags.
  asyncFlags[kWatchedProviders] = activeContext._asyncWatchedProviders;
  asyncFlags[kActiveAsyncQueueLength] = activeContext._asyncQueue.length;

  var cslen = contextStack.length;
  if (cslen === 0)
    return;

  // Remove the AsyncListener from all contexts in the current stack.
  for (var i = 0; i < cslen; i++)
    removeAL(contextStack[i], al);
}


function removeAL(ctx, al) {
  // Return early if the AsyncListener doesn't exist in this context.
  if (ctx._asyncData[al.uid] === undefined)
    return;

  var data = ctx._asyncData;
  var queue = ctx._asyncQueue;
  var i, tmp;

  ctx._asyncCallbackFlags = HAS_NONE_AL;
  ctx._asyncWatchedProviders = ASYNC_PROVIDERS.NONE;
  for (i = 0; i < queue.length; i++) {
    if (queue[i] === al) {
      tmp = queue.splice(i, 1)[0];
      data[tmp.uid] = undefined;
      i--;
    } else {
      ctx._asyncCallbackFlags |= queue[i].callback_flags;
      ctx._asyncWatchedProviders |= queue[i].watched_providers;
    }
  }

  // Set async_flags_ = NO_OPTIONS in C++ where possible. In some locations
  // it is impossible to reach the actual context because it is abstracted
  // too far (e.g. TimerWrap).
  if (queue.length === 0 && typeof ctx._removeAsyncQueue === 'function')
    ctx._removeAsyncQueue();
}


var _nextTick = process.nextTick;
var _setImmediate = global.setImmediate;
var _setTimeout = global.setTimeout;
var _setInterval = global.setInterval;


function alWrap(cb) {
  return function alWrapImplementation() {
    loadAsyncQueue(cb);
    var ret = cb.apply(this, arguments);
    unloadAsyncQueue(cb);
    return ret;
  }
}


process.nextTick = function nextTick(cb) {
  if (asyncFlags[kActiveAsyncQueueLength] > 0)
    runAsyncQueue(cb, ASYNC_PROVIDERS.NEXTTICK);

  var nextTickWrap = alWrap(cb);
  arguments[0] = nextTickWrap;

  return _nextTick.apply(this, arguments);
};


global.setImmediate = function setImmediate(cb) {
  var ret;

  var ocb = cb;

  function immediateWrap() {
    loadAsyncQueue(ret);
    var inner = ocb.apply(this, arguments);
    unloadAsyncQueue(ret);
    return inner;
  }
  arguments[0] = immediateWrap;

  ret = _setImmediate.apply(this, arguments);

  if (asyncFlags[kActiveAsyncQueueLength] > 0)
    runAsyncQueue(ret, ASYNC_PROVIDERS.TIMER);

  return ret;
};


global.setTimeout = function setTimeout(cb) {
  var ret;

  var ocb = cb;

  function timeoutWrap() {
    loadAsyncQueue(ret);
    var inner = ocb.apply(this, arguments);
    unloadAsyncQueue(ret);
    return inner;
  }
  arguments[0] = timeoutWrap;

  ret = _setTimeout.apply(this, arguments);

  if (asyncFlags[kActiveAsyncQueueLength] > 0)
    runAsyncQueue(ret, ASYNC_PROVIDERS.TIMER);

  return ret;
};


global.setInterval = function setInterval(cb) {
  var ret;

  var ocb = cb;

  function intervalWrap() {
    loadAsyncQueue(ret);
    var inner = ocb.apply(this, arguments);
    unloadAsyncQueue(ret);
    return inner;
  }
  arguments[0] = intervalWrap;

  ret = _setInterval.apply(this, arguments);

  if (asyncFlags[kActiveAsyncQueueLength] > 0)
    runAsyncQueue(ret, ASYNC_PROVIDERS.TIMER);

  return ret;
};


/* debug:start */
// XXX: For debugging. Remove before commit.
exports.showActiveContext = function() {
  process._rawDebug();
  process._rawDebug('*** contextStack');
  process._rawDebug(contextStack);
  process._rawDebug();
  process._rawDebug('*** activeContext');
  process._rawDebug(activeContext);
  process._rawDebug();
};
/* debug:stop */
