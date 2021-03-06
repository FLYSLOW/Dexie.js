import {doFakeAutoComplete, tryCatch, props,
        setProp, _global, getPropertyDescriptor, getArrayOf, extend} from './utils';
import {nop, callBoth, mirror} from './chaining-functions';
import {debug, prettyStack, getErrorWithStack} from './debug';

//
// Promise Class for Dexie library
//
// I started out writing this Promise class by copying promise-light (https://github.com/taylorhakes/promise-light) by
// https://github.com/taylorhakes - an A+ and ECMASCRIPT 6 compliant Promise implementation.
//
// Modifications needed to be done to support indexedDB because it wont accept setTimeout()
// (See discussion: https://github.com/promises-aplus/promises-spec/issues/45) .
// This topic was also discussed in the following thread: https://github.com/promises-aplus/promises-spec/issues/45
//
// This implementation will not use setTimeout or setImmediate when it's not needed. The behavior is 100% Promise/A+ compliant since
// the caller of new Promise() can be certain that the promise wont be triggered the lines after constructing the promise.
//
// In previous versions this was fixed by not calling setTimeout when knowing that the resolve() or reject() came from another
// tick. In Dexie v1.4.0, I've rewritten the Promise class entirely. Just some fragments of promise-light is left. I use
// another strategy now that simplifies everything a lot: to always execute callbacks in a new tick, but have an own microTick
// engine that is used instead of setImmediate() or setTimeout().
// Promise class has also been optimized a lot with inspiration from bluebird - to avoid closures as much as possible.
// Also with inspiration from bluebird, asyncronic stacks in debug mode.
//
// Specific non-standard features of this Promise class:
// * Async static context support (Promise.PSD)
// * Promise.follow() method built upon PSD, that allows user to track all promises created from current stack frame
//   and below + all promises that those promises creates or awaits.
// * Detect any unhandled promise in a PSD-scope (PSD.onunhandled). 
//
// David Fahlander, https://github.com/dfahlander
//

// Just a pointer that only this module knows about.
// Used in Promise constructor to emulate a private constructor.
var INTERNAL = {};

// Async stacks (long stacks) must not grow infinitely.
const
    LONG_STACKS_CLIP_LIMIT = 100,
    // When calling error.stack or promise.stack, limit the number of asyncronic stacks to print out. 
    MAX_LONG_STACKS = 20,
    nativePromiseInstanceAndProto = (()=>{
        try {
            // Be able to patch native async functions
            return new Function("let p=(async ()=>{})(); return [p, Object.getPrototypeOf(p)];")();
        } catch(e) {
            var P = _global.Promise;
            return [P && P.resolve(), P && P.prototype]; // Support transpiled async functions 
        }
    })(),
    resolvedNativePromise = nativePromiseInstanceAndProto[0],
    nativePromiseProto = nativePromiseInstanceAndProto[1],
    resolvedGlobalPromise = _global.Promise && _global.Promise.resolve(),
    nativePromiseThen = nativePromiseProto && nativePromiseProto.then;
    
var stack_being_generated = false;    

/* The default function used only for the very first promise in a promise chain.
   As soon as then promise is resolved or rejected, all next tasks will be executed in micro ticks
   emulated in this module. For indexedDB compatibility, this means that every method needs to 
   execute at least one promise before doing an indexedDB operation. Dexie will always call 
   db.ready().then() for every operation to make sure the indexedDB event is started in an
   indexedDB-compatible emulated micro task loop.
*/
var schedulePhysicalTick = resolvedGlobalPromise ?
    () => {
        usePSD(globalPSD, () => {
        resolvedGlobalPromise.then(physicalTick);} ) }:
    _global.setImmediate ? 
        // setImmediate supported. Those modern platforms also supports Function.bind().
        setImmediate.bind(null, physicalTick) :
        _global.MutationObserver ?
            // MutationObserver supported
            () => {
                var hiddenDiv = document.createElement("div");
                (new MutationObserver(() => {
                    physicalTick();
                    hiddenDiv = null;
                })).observe(hiddenDiv, { attributes: true });
                hiddenDiv.setAttribute('i', '1');
            } :
            // No support for setImmediate or MutationObserver. No worry, setTimeout is only called
            // once time. Every tick that follows will be our emulated micro tick.
            // Could have uses setTimeout.bind(null, 0, physicalTick) if it wasnt for that FF13 and below has a bug 
            ()=>{setTimeout(physicalTick,0);};

// Configurable through Promise.scheduler.
// Don't export because it would be unsafe to let unknown
// code call it unless they do try..catch within their callback.
// This function can be retrieved through getter of Promise.scheduler though,
// but users must not do Promise.scheduler = myFuncThatThrowsException
var asap = function (callback, args) {
    microtickQueue.push([callback, args]);
    if (needsNewPhysicalTick) {
        schedulePhysicalTick();
        needsNewPhysicalTick = false;
    }
};

var isOutsideMicroTick = true, // True when NOT in a virtual microTick.
    needsNewPhysicalTick = true, // True when a push to microtickQueue must also schedulePhysicalTick()
    unhandledErrors = [], // Rejected promises that has occured. Used for triggering 'unhandledrejection'.
    rejectingErrors = [], // Tracks if errors are being re-rejected during onRejected callback.
    currentFulfiller = null,
    rejectionMapper = mirror; // Remove in next major when removing error mapping of DOMErrors and DOMExceptions
    
export var globalPSD = {
    global: true,
    ref: 0,
    unhandleds: [],
    onunhandled: globalError,
    pgp: false,
    env: { // Environment globals snapshotted on leaving global zone
        Promise: _global.Promise,
        nc: nativePromiseProto && nativePromiseProto.constructor,
        nthen: nativePromiseProto && nativePromiseProto.then,
        gthen: _global.Promise && _global.Promise.prototype.then,
        dthen: null // Will be set later on.
    },
    finalize: function () {
        this.unhandleds.forEach(uh => {
            try {
                globalError(uh[0], uh[1]);
            } catch (e) {}
        });
    }
};

export var PSD = globalPSD;

export var microtickQueue = []; // Callbacks to call in this or next physical tick.
export var numScheduledCalls = 0; // Number of listener-calls left to do in this physical tick.
export var tickFinalizers = []; // Finalizers to call when there are no more async calls scheduled within current physical tick.

export default function Promise(fn) {
    if (typeof this !== 'object') throw new TypeError('Promises must be constructed via new');    
    this._listeners = [];
    this.onuncatched = nop; // Deprecate in next major. Not needed. Better to use global error handler.
    
    // A library may set `promise._lib = true;` after promise is created to make resolve() or reject()
    // execute the microtask engine implicitely within the call to resolve() or reject().
    // To remain A+ compliant, a library must only set `_lib=true` if it can guarantee that the stack
    // only contains library code when calling resolve() or reject().
    // RULE OF THUMB: ONLY set _lib = true for promises explicitely resolving/rejecting directly from
    // global scope (event handler, timer etc)!
    this._lib = false;
    // Current async scope
    var psd = (this._PSD = PSD);

    if (debug) {
        this._stackHolder = getErrorWithStack();
        this._prev = null;
        this._numPrev = 0; // Number of previous promises (for long stacks)
        linkToPreviousPromise(this, currentFulfiller);
    }
    
    if (typeof fn !== 'function') {
        if (fn !== INTERNAL) throw new TypeError('Not a function');
        // Private constructor (INTERNAL, state, value).
        // Used internally by Promise.resolve() and Promise.reject().
        this._state = arguments[1];
        this._value = arguments[2];
        if (this._state === false)
            handleRejection(this, this._value); // Map error, set stack and addPossiblyUnhandledError().
        return;
    }
    
    this._state = null; // null (=pending), false (=rejected) or true (=resolved)
    this._value = null; // error or result
    ++psd.ref; // Refcounting current scope
    executePromiseTask(this, fn);
}

props(Promise.prototype, {

    then: function (onFulfilled, onRejected) {
        var rv = new Promise((resolve, reject) => {
            propagateToListener(this, new Listener(onFulfilled, onRejected, resolve, reject, PSD));
        });
        debug && (!this._prev || this._state === null) && linkToPreviousPromise(rv, this);
        return rv;
    },
        
    _then: function (onFulfilled, onRejected) {
        // A little tinier version of then() that don't have to create a resulting promise.
        propagateToListener(this, new Listener(null, null, onFulfilled, onRejected, PSD));        
    },

    catch: function (onRejected) {
        if (arguments.length === 1) return this.then(null, onRejected);
        // First argument is the Error type to catch
        var type = arguments[0],
            handler = arguments[1];
        return typeof type === 'function' ? this.then(null, err =>
            // Catching errors by its constructor type (similar to java / c++ / c#)
            // Sample: promise.catch(TypeError, function (e) { ... });
            err instanceof type ? handler(err) : PromiseReject(err))
        : this.then(null, err =>
            // Catching errors by the error.name property. Makes sense for indexedDB where error type
            // is always DOMError but where e.name tells the actual error type.
            // Sample: promise.catch('ConstraintError', function (e) { ... });
            err && err.name === type ? handler(err) : PromiseReject(err));
    },

    finally: function (onFinally) {
        return this.then(value => {
            onFinally();
            return value;
        }, err => {
            onFinally();
            return PromiseReject(err);
        });
    },
    
    stack: {
        get: function() {
            if (this._stack) return this._stack;
            try {
                stack_being_generated = true;
                var stacks = getStack (this, [], MAX_LONG_STACKS);
                var stack = stacks.join("\nFrom previous: ");
                if (this._state !== null) this._stack = stack; // Stack may be updated on reject.
                return stack;
            } finally {
                stack_being_generated = false;
            }
        }
    }
});

function Listener(onFulfilled, onRejected, resolve, reject, zone) {
    this.onFulfilled = typeof onFulfilled === 'function' ? onFulfilled : null;
    this.onRejected = typeof onRejected === 'function' ? onRejected : null;
    this.resolve = resolve;
    this.reject = reject;
    this.psd = zone;
}

// Promise Static Properties
props (Promise, {
    all: function () {
        var values = getArrayOf.apply(null, arguments); // Supports iterables, implicit arguments and array-like.
        return new Promise(function (resolve, reject) {
            if (values.length === 0) resolve([]);
            var remaining = values.length;
            values.forEach((a,i) => Promise.resolve(a).then(x => {
                values[i] = x;
                if (!--remaining) resolve(values);
            }, reject));
        });
    },
    
    resolve: value => {
        if (value instanceof Promise) return value;
        if (value && typeof value.then === 'function') return new Promise((resolve, reject)=>{
            value.then(resolve, reject);
        });
        return new Promise(INTERNAL, true, value);
    },
    
    reject: PromiseReject,
    
    race: function () {
        var values = getArrayOf.apply(null, arguments);
        return new Promise((resolve, reject) => {
            values.map(value => Promise.resolve(value).then(resolve, reject));
        });
    },
    
    PSD: {
        get: ()=>PSD,
        set: value => PSD = value
    },
    
    newPSD: newScope,
    
    usePSD: usePSD,
    
    scheduler: {
        get: () => asap,
        set: value => {asap = value}
    },
    
    rejectionMapper: {
        get: () => rejectionMapper,
        set: value => {rejectionMapper = value;} // Map reject failures
    },
            
    follow: (fn, zoneProps) => {
        return new Promise((resolve, reject) => {
            return newScope((resolve, reject) => {
                var psd = PSD;
                psd.unhandleds = []; // For unhandled standard- or 3rd party Promises. Checked at psd.finalize()
                psd.onunhandled = reject; // Triggered directly on unhandled promises of this library.
                psd.finalize = callBoth(function () {
                    // Unhandled standard or 3rd part promises are put in PSD.unhandleds and
                    // examined upon scope completion while unhandled rejections in this Promise
                    // will trigger directly through psd.onunhandled
                    run_at_end_of_this_or_next_physical_tick(()=>{
                        this.unhandleds.length === 0 ? resolve() : reject(this.unhandleds[0]);
                    });
                }, psd.finalize);
                fn();
            }, zoneProps, resolve, reject);
        });
    }
});

/**
* Take a potentially misbehaving resolver function and make sure
* onFulfilled and onRejected are only called once.
*
* Makes no guarantees about asynchrony.
*/
function executePromiseTask (promise, fn) {
    // Promise Resolution Procedure:
    // https://github.com/promises-aplus/promises-spec#the-promise-resolution-procedure
    try {
        fn(value => {
            if (promise._state !== null) return; // Already settled
            if (value === promise) throw new TypeError('A promise cannot be resolved with itself.');
            var shouldExecuteTick = promise._lib && beginMicroTickScope();
            if (value && typeof value.then === 'function') {
                executePromiseTask(promise, (resolve, reject) => {
                    value instanceof Promise ?
                        value._then(resolve, reject) :
                        value.then(resolve, reject);
                });
            } else {
                promise._state = true;
                promise._value = value;
                propagateAllListeners(promise);
            }
            if (shouldExecuteTick) endMicroTickScope();
        }, handleRejection.bind(null, promise)); // If Function.bind is not supported. Exception is handled in catch below
    } catch (ex) {
        handleRejection(promise, ex);
    }
}

function handleRejection (promise, reason) {
    rejectingErrors.push(reason);
    if (promise._state !== null) return;
    var shouldExecuteTick = promise._lib && beginMicroTickScope();
    reason = rejectionMapper(reason);
    promise._state = false;
    promise._value = reason;
    debug && reason !== null && typeof reason === 'object' && !reason._promise && tryCatch(()=>{
        var origProp = getPropertyDescriptor(reason, "stack");        
        reason._promise = promise;    
        setProp(reason, "stack", {
            get: () =>
                stack_being_generated ?
                    origProp && (origProp.get ?
                                origProp.get.apply(reason) :
                                origProp.value) :
                    promise.stack
        });
    });
    // Add the failure to a list of possibly uncaught errors
    addPossiblyUnhandledError(promise);
    propagateAllListeners(promise);
    if (shouldExecuteTick) endMicroTickScope();
}

function propagateAllListeners (promise) {
    //debug && linkToPreviousPromise(promise);
    var listeners = promise._listeners;
    promise._listeners = [];
    for (var i = 0, len = listeners.length; i < len; ++i) {
        propagateToListener(promise, listeners[i]);
    }
    var psd = promise._PSD;
    --psd.ref || psd.finalize(); // if psd.ref reaches zero, call psd.finalize();
    if (numScheduledCalls === 0) {
        // If numScheduledCalls is 0, it means that our stack is not in a callback of a scheduled call,
        // and that no deferreds where listening to this rejection or success.
        // Since there is a risk that our stack can contain application code that may
        // do stuff after this code is finished that may generate new calls, we cannot
        // call finalizers here.
        ++numScheduledCalls;
        asap(()=>{
            if (--numScheduledCalls === 0) finalizePhysicalTick(); // Will detect unhandled errors
        }, []);
    }
}

function propagateToListener(promise, listener) {
    if (promise._state === null) {
        promise._listeners.push(listener);
        return;
    }

    var cb = promise._state ? listener.onFulfilled : listener.onRejected;
    if (cb === null) {
        // This Listener doesnt have a listener for the event being triggered (onFulfilled or onReject) so lets forward the event to any eventual listeners on the Promise instance returned by then() or catch()
        return (promise._state ? listener.resolve : listener.reject) (promise._value);
    }
    ++listener.psd.ref;
    ++numScheduledCalls;
    asap (callListener, [cb, promise, listener]);
}

function callListener (cb, promise, listener) {
    try {
        // Set static variable currentFulfiller to the promise that is being fullfilled,
        // so that we connect the chain of promises (for long stacks support)
        currentFulfiller = promise;
        
        // Call callback and resolve our listener with it's return value.
        var ret, value = promise._value;
            
        if (promise._state) {
            // cb is onResolved
            ret = cb (value);
        } else {
            // cb is onRejected
            if (rejectingErrors.length) rejectingErrors = [];
            ret = cb(value);
            if (rejectingErrors.indexOf(value) === -1)
                markErrorAsHandled(promise); // Callback didnt do Promise.reject(err) nor reject(err) onto another promise.
        }
        listener.resolve(ret);
    } catch (e) {
        // Exception thrown in callback. Reject our listener.
        listener.reject(e);
    } finally {
        // Restore env and currentFulfiller.
        currentFulfiller = null;
        if (--numScheduledCalls === 0) finalizePhysicalTick();
        --listener.psd.ref || listener.psd.finalize();
    }
}

function getStack (promise, stacks, limit) {
    if (stacks.length === limit) return stacks;
    var stack = "";
    if (promise._state === false) {
        var failure = promise._value,
            errorName,
            message;
        
        if (failure != null) {
            errorName = failure.name || "Error";
            message = failure.message || failure;
            stack = prettyStack(failure, 0);
        } else {
            errorName = failure; // If error is undefined or null, show that.
            message = "";
        }
        stacks.push(errorName + (message ? ": " + message : "") + stack);
    }
    if (debug) {
        stack = prettyStack(promise._stackHolder, 2);
        if (stack && stacks.indexOf(stack) === -1) stacks.push(stack);
        if (promise._prev) getStack(promise._prev, stacks, limit);
    }
    return stacks;
}

function linkToPreviousPromise(promise, prev) {
    // Support long stacks by linking to previous completed promise.
    var numPrev = prev ? prev._numPrev + 1 : 0;
    if (numPrev < LONG_STACKS_CLIP_LIMIT) { // Prohibit infinite Promise loops to get an infinite long memory consuming "tail".
        promise._prev = prev;
        promise._numPrev = numPrev;
    }
}

/* The callback to schedule with setImmediate() or setTimeout().
   It runs a virtual microtick and executes any callback registered in microtickQueue.
 */
function physicalTick() {
    beginMicroTickScope() && endMicroTickScope();
}

function beginMicroTickScope() {
    var wasRootExec = isOutsideMicroTick;
    isOutsideMicroTick = false;
    needsNewPhysicalTick = false;
    return wasRootExec;
}

/* Executes micro-ticks without doing try..catch.
   This can be possible because we only use this internally and
   the registered functions are exception-safe (they do try..catch
   internally before calling any external method). If registering
   functions in the microtickQueue that are not exception-safe, this
   would destroy the framework and make it instable. So we don't export
   our asap method.
*/
function endMicroTickScope() {
    var callbacks, i, l;
    do {
        while (microtickQueue.length > 0) {
            callbacks = microtickQueue;
            microtickQueue = [];
            l = callbacks.length;
            for (i = 0; i < l; ++i) {
                var item = callbacks[i];
                item[0].apply(null, item[1]);
            }
        }
    } while (microtickQueue.length > 0);
    isOutsideMicroTick = true;
    needsNewPhysicalTick = true;
}

function finalizePhysicalTick() {
    var unhandledErrs = unhandledErrors;
    unhandledErrors = [];
    unhandledErrs.forEach(p => {
        p._PSD.onunhandled.call(null, p._value, p);
    });
    var finalizers = tickFinalizers.slice(0); // Clone first because finalizer may remove itself from list.
    var i = finalizers.length;
    while (i) finalizers[--i]();    
}

function run_at_end_of_this_or_next_physical_tick (fn) {
    function finalizer() {
        fn();
        tickFinalizers.splice(tickFinalizers.indexOf(finalizer), 1);
    }
    tickFinalizers.push(finalizer);
    ++numScheduledCalls;
    asap(()=>{
        if (--numScheduledCalls === 0) finalizePhysicalTick();
    }, []);
}

function addPossiblyUnhandledError(promise) {
    // Only add to unhandledErrors if not already there. The first one to add to this list
    // will be upon the first rejection so that the root cause (first promise in the
    // rejection chain) is the one listed.
    if (!unhandledErrors.some(p => p._value === promise._value))
        unhandledErrors.push(promise);
}

function markErrorAsHandled(promise) {
    // Called when a reject handled is actually being called.
    // Search in unhandledErrors for any promise whos _value is this promise_value (list
    // contains only rejected promises, and only one item per error)
    var i = unhandledErrors.length;
    while (i) if (unhandledErrors[--i]._value === promise._value) {
        // Found a promise that failed with this same error object pointer,
        // Remove that since there is a listener that actually takes care of it.
        unhandledErrors.splice(i, 1);
        return;
    }
}

function PromiseReject (reason) {
    return new Promise(INTERNAL, false, reason);
}


export function wrap (fn, errorCatcher) {
    var psd = PSD;
    return function() {
        var wasRootExec = beginMicroTickScope(),
            outerScope = PSD;

        try {
            switchToZone(psd);
            return fn.apply(this, arguments);
        } catch (e) {
            errorCatcher && errorCatcher(e);
        } finally {
            switchToZone(outerScope);
            if (wasRootExec) endMicroTickScope();
        }
    };
}


globalPSD.env.dthen = Promise.prototype.then;
    
export function newScope (fn, props, a1, a2) {
    var parent = PSD,
        psd = Object.create(parent);
    psd.parent = parent;
    psd.ref = 0;
    psd.global = false;
    // Prepare for promise patching (done in usePSD):
    var globalEnv = globalPSD.env;
    psd.env = nativePromiseThen ? {
        Promise: Promise, // Changing window.Promise could be omitted for Chrome and Edge, where IDB+Promise plays well!
        nc: Promise, 
        nthen: getPatchedPromiseThen (globalEnv.nthen, psd), // native then
        gthen: getPatchedPromiseThen (globalEnv.gthen, psd), // global then
        dthen: getPatchedPromiseThen (globalEnv.dthen, psd)  // dexie then
    } : {
        dthen: getPatchedPromiseThen (globalEnv.dthen, psd)
    };
    if (props) extend(psd, props);
    
    // unhandleds and onunhandled should not be specifically set here.
    // Leave them on parent prototype.
    // unhandleds.push(err) will push to parent's prototype
    // onunhandled() will call parents onunhandled (with this scope's this-pointer though!)
    ++parent.ref;
    psd.finalize = function () {
        --this.parent.ref || this.parent.finalize();
    }
    var rv = usePSD (psd, fn, a1, a2);
    if (psd.ref === 0) psd.finalize();
    return rv;
}

function switchToZone (targetZone) {
    if (targetZone === PSD) return;
    var currentZone = PSD;
    PSD = targetZone;
    
    // Snapshot on every leave from global zone.
    if (currentZone === globalPSD && ('Promise' in _global)) {
        var globalEnv = globalPSD.env;
        globalEnv.Promise = _global.Promise; // Changing window.Promise could be omitted for Chrome and Edge, where IDB+Promise plays well!
        globalEnv.nc = nativePromiseProto.constructor;
        globalEnv.nthen = nativePromiseProto.then;
        globalEnv.gthen = _global.Promise.prototype.then;
        globalEnv.dthen = Promise.prototype.then;
    }
    
    // Patch our own Promise to keep zones in it:
    Promise.prototype.then = targetZone.env.dthen;
    
    if (('Promise' in _global)) {
        // Swich environments
        
        // Set this Promise to window.Promise so that Typescript 2.0's async functions will work on Firefox, Safari and IE, as well as with Zonejs and angular.
        _global.Promise = targetZone.env.Promise;
        
        // Make native async functions work according to their standard specification but invoke our zones
        // (https://github.com/tc39/ecmascript-asyncawait/issues/65)
        nativePromiseProto.then = targetZone.env.nthen;
        
        // Also override constructor (https://github.com/tc39/ecmascript-asyncawait/issues/65#issuecomment-145250337)
        nativePromiseProto.constructor = targetZone.env.nc;
        
        // Also patch the global Promise in case it differs from native Promise (must work with transpilers and polyfills)
        globalPSD.env.Promise.prototype.then = targetZone.env.gthen;
    }
}

export function usePSD (psd, fn, a1, a2, a3) {
    var outerScope = PSD;
    try {
        switchToZone(psd);
        return fn(a1, a2, a3);
    } finally {
        switchToZone(outerScope);
    }
}

function enqueueNativeMicroTask (job) {
    //
    // Precondition: nativePromiseThen !== undefined
    //
    nativePromiseThen.call(resolvedNativePromise, job);
}

function nativeAwaitCompatibleWrap(fn, zone, possibleAwait) {
    return typeof fn !== 'function' ? fn : function () {
        var outerZone = PSD;
        switchToZone(zone);
        if (possibleAwait) {
            // Before calling fn (which is onResolved or onRejected),
            // enque a zone injector onto the Micro Task queue, because when fn() is executed,
            // it will call resolvingFunctions.[[Resolve]] or resolvingFunctions.[[Reject]] as
            // specified in ES2015, PromiseResolveThenableJob http://www.ecma-international.org/ecma-262/6.0/#sec-promiseresolvethenablejob
            // Thos [[Resolve]] and [[Reject]] internal slots will in its turn enqueue its internal
            // onResolved or onRejected callbacks on the "PromiseJobs" queue. We must enque a zone-
            // invoker and zone-resetter before and after the native queue record.
            ++zone.ref;
            enqueueNativeMicroTask(()=>{
                switchToZone(zone);
            });
        }
        try {
            return fn.apply(this, arguments);
        } finally {
            switchToZone(outerZone);
            if (possibleAwait) {
                enqueueNativeMicroTask(()=>{
                    switchToZone(globalPSD);
                    --zone.ref || zone.finalize(); // if ref reaches zero, call finalize();
                });
            }
        }
    };
}

function getPatchedPromiseThen (origThen, zone) {
    return function (onResolved, onRejected) {
        var possibleAwait = (zone !== PSD) && !!nativePromiseThen;
        return origThen.call(this,
            nativeAwaitCompatibleWrap(onResolved, zone, possibleAwait),
            nativeAwaitCompatibleWrap(onRejected, zone, possibleAwait));
    };
}

const UNHANDLEDREJECTION = "unhandledrejection";

function globalError(err, promise) {
    var rv;
    try {
        rv = promise.onuncatched(err);
    } catch (e) {}
    if (rv !== false) try {
        var event, eventData = {promise: promise, reason: err};
        if (_global.document && document.createEvent) {
            event = document.createEvent('Event');
            event.initEvent(UNHANDLEDREJECTION, true, true);
            extend(event, eventData);
        } else if (_global.CustomEvent) {
            event = new CustomEvent(UNHANDLEDREJECTION, {detail: eventData});
            extend(event, eventData);
        }
        if (event && _global.dispatchEvent) {
            dispatchEvent(event);
            if (!_global.PromiseRejectionEvent && _global.onunhandledrejection)
                // No native support for PromiseRejectionEvent but user has set window.onunhandledrejection. Manually call it.
                try {_global.onunhandledrejection(event);} catch (_) {}
        }
        if (!event.defaultPrevented) {
            console.warn(`Unhandled rejection: ${err.stack || err}`);
        }
    } catch (e) {}
}

doFakeAutoComplete(() => {
    // Simplify the job for VS Intellisense. This piece of code is one of the keys to the new marvellous intellisense support in Dexie.
    asap = (fn, args) => {
        setTimeout(()=>{fn.apply(null, args);}, 0);
    };
});

export var rejection = Promise.reject;
