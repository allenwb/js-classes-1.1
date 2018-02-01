let subscriptionClosed;
let closeSubscription;
let validateSubscription;
let cleanupSubscription;
let setState;
let getObserver;

class Subscription {
  let _state = 'initializing';
  let _observer;
  let _cleanup;

  constructor(observer, subscriber) {
    _observer = observer;

    let subscriptionObserver = new SubscriptionObserver(this);

    try {
      _cleanup = subscriber.call(undefined, subscriptionObserver);
    } catch (err) {
      enqueue(() => subscriptionObserver.error(err));
    }

    _state = 'ready';
  }

  unsubscribe() {
    if (!subscriptionClosed(this)) {
      closeSubscription(this);
      cleanupSubscription(this);
    }
  }

  static {

    subscriptionClosed = s => {
      return s->_state = 'closed';
    };

    closeSubscription = s => {
      s->_observer = undefined;
      s->_state = 'closed';
    };

    validateSubscription = s => {
      switch (s->_state) {
        case 'ready': break;
        case 'initializing': throw new Error('Subscription is not initialized');
        case 'running': throw new Error('Subscription observer is already running');
      }
    };

    cleanupSubscription = s => {
      let cleanup = s->_cleanup;
      if (cleanup === undefined)
        return;

      s->_cleanup = undefined;
      if (!cleanup) {
        return;
      }

      if (typeof cleanup === 'function') {
        cleanup();
      } else {
        let unsubscribe = getMethod(cleanup, 'unsubscribe');
        if (unsubscribe) {
          unsubscribe.call(cleanup);
        }
      }
    };

    setState = (s, state) => {
      s->_state = state;
    };

    getObserver = s => {
      return s->_observer;
    };

  }

}

class SubscriptionObserver {
  let _subscription;

  constructor(subscription) {
    _subscription = subscription;
  }

  get closed() {
    return subscriptionClosed(_subscription);
  }

  next(value) {
    if (subscriptionClosed(_subscription))
      return;

    validateSubscription(_subscription);

    let observer = getObserver(_subscription);
    let m = getMethod(observer, 'next');
    if (!m) return;

    setState(_subscription, 'running');

    try {
      m.call(observer, value);
    } finally {
      if (!subscriptionClosed(_subscription))
        setState(_subscription, 'ready');
    }
  }

  error(value) {
    if (subscriptionClosed(_subscription)) {
      throw value;
    }

    validateSubscription(_subscription);

    let observer = getObserver(_subscription);
    closeSubscription(_subscription);

    try {
      let m = getMethod(observer, 'error');
      if (m) m.call(observer, value);
      else throw value;
    } catch (e) {
      try { cleanupSubscription(_subscription) }
      finally { throw e }
    }

    cleanupSubscription(subscription);
  }

  complete() {
    if (subscriptionClosed(_subscription))
      return;

    validateSubscription(_subscription);

    let observer = getObserver(_subscription);
    closeSubscription(_subscription);

    try {
      let m = getMethod(observer, 'complete');
      if (m) m.call(observer);
    } catch (e) {
      try { cleanupSubscription(_subscription) }
      finally { throw e }
    }

    cleanupSubscription(_subscription);
  }

}

class Observable {
  let _subscriber;

  constructor(subscriber) {
    if (!(this instanceof Observable))
      throw new TypeError('Observable cannot be called as a function');

    if (typeof subscriber !== 'function')
      throw new TypeError('Observable initializer must be a function');

    _subscriber = subscriber;
  }

  subscribe(observer) {
    if (typeof observer !== 'object' || observer === null) {
      observer = {
        next: observer,
        error: arguments[1],
        complete: arguments[2],
      };
    }
    return new Subscription(observer, _subscriber);
  }

  forEach(fn) {
    return new Promise((resolve, reject) => {
      if (typeof fn !== 'function') {
        reject(new TypeError(fn + ' is not a function'));
        return;
      }

      let subscription = this.subscribe({
        next(value) {
          try {
            fn(value);
          } catch (err) {
            reject(err);
            subscription.unsubscribe();
          }
        },
        error: reject,
        complete: resolve,
      });
    });
  }

  map(fn) {
    if (typeof fn !== 'function')
      throw new TypeError(fn + ' is not a function');

    let C = getSpecies(this);

    return new C(observer => this.subscribe({
      next(value) {
        try { value = fn(value) }
        catch (e) { return observer.error(e) }
        observer.next(value);
      },
      error(e) { observer.error(e) },
      complete() { observer.complete() },
    }));
  }

  filter(fn) {
    if (typeof fn !== 'function')
      throw new TypeError(fn + ' is not a function');

    let C = getSpecies(this);

    return new C(observer => this.subscribe({
      next(value) {
        try { if (!fn(value)) return; }
        catch (e) { return observer.error(e) }
        observer.next(value);
      },
      error(e) { observer.error(e) },
      complete() { observer.complete() },
    }));
  }

  reduce(fn) {
    if (typeof fn !== 'function')
      throw new TypeError(fn + ' is not a function');

    let C = getSpecies(this);
    let hasSeed = arguments.length > 1;
    let hasValue = false;
    let seed = arguments[1];
    let acc = seed;

    return new C(observer => this.subscribe({

      next(value) {
        let first = !hasValue;
        hasValue = true;

        if (!first || hasSeed) {
          try { acc = fn(acc, value) }
          catch (e) { return observer.error(e) }
        } else {
          acc = value;
        }
      },

      error(e) { observer.error(e) },

      complete() {
        if (!hasValue && !hasSeed)
          return observer.error(new TypeError('Cannot reduce an empty sequence'));

        observer.next(acc);
        observer.complete();
      },

    }));
  }

  [Symbol.observable]() {
    return this;
  }

  static from(x) {
    let C = typeof this === 'function' ? this : Observable;

    if (x == null)
      throw new TypeError(x + ' is not an object');

    let method = getMethod(x, getSymbol('observable'));
    if (method) {
      let observable = method.call(x);

      if (Object(observable) !== observable)
        throw new TypeError(observable + ' is not an object');

      if (observable.constructor === C) // SPEC: Brand check?
        return observable;

      return new C(observer => observable.subscribe(observer));
    }

    if (hasSymbol('iterator')) {
      method = getMethod(x, getSymbol('iterator'));
      if (method) {
        return new C(observer => {
          enqueue(() => {
            if (observer.closed) return;
            for (let item of method.call(x)) {
              observer.next(item);
              if (observer.closed) return;
            }
            observer.complete();
          });
        });
      }
    }

    if (Array.isArray(x)) {
      return new C(observer => {
        enqueue(() => {
          if (observer.closed) return;
          for (let i = 0; i < x.length; ++i) {
            observer.next(x[i]);
            if (observer.closed) return;
          }
          observer.complete();
        });
      });
    }

    throw new TypeError(x + ' is not observable');
  }

  static of(...items) {
    let C = typeof this === 'function' ? this : Observable;

    return new C(observer => {
      enqueue(() => {
        if (observer.closed) return;
        for (let i = 0; i < items.length; ++i) {
          observer.next(items[i]);
          if (observer.closed) return;
        }
        observer.complete();
      });
    });
  }

  static [Symbol.species]() {
    return this;
  }

}

// === Symbol Support ===

function hasSymbol(name) {
  return typeof Symbol === 'function' && Boolean(Symbol[name]);
}

function getSymbol(name) {
  return hasSymbol(name) ? Symbol[name] : '@@' + name;
}

// === Abstract Operations ===

function getMethod(obj, key) {
  let value = obj[key];

  if (value == null)
    return undefined;

  if (typeof value !== 'function')
    throw new TypeError(value + ' is not a function');

  return value;
}

function getSpecies(obj) {
  let ctor = obj.constructor;
  if (ctor !== undefined) {
    ctor = ctor[getSymbol('species')];
    if (ctor === null) {
      ctor = undefined;
    }
  }
  return ctor !== undefined ? ctor : Observable;
}

function enqueue(fn) {
  Promise.resolve().then(() => {
    try { fn() }
    catch (err) { setTimeout(() => { throw err }) }
  });
}
