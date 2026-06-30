const listeners = new Set();

export const store = {
  state: {
    user: null,
    loading: false,
    error: null,
    view: 'users',
    users: [],
    currentUser: null,
    currentItems: [],
    mediaIndex: 0,
    mediaList: [],
    mediaLoading: false,
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  emit() {
    for (const fn of listeners) {
      try { fn(this.state); } catch (err) { console.warn('store subscriber error:', err); }
    }
  },

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit();
  },

  reset() {
    this.set({
      loading: false,
      error: null,
      view: 'users',
      currentUser: null,
      currentItems: [],
      mediaIndex: 0,
      mediaList: [],
      mediaLoading: false,
      users: [],
    });
  },
};
