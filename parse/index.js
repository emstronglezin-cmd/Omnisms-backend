// Mock Parse SDK for development
const Parse = {
  initialize: () => {},
  serverURL: '',
  User: class MockUser {
    constructor() {
      this.attributes = {};
    }
    set(key, value) {
      this.attributes[key] = value;
      return this;
    }
    get(key) {
      return this.attributes[key];
    }
    getSessionToken() {
      return 'mock-session-token-' + Math.random();
    }
    static async logIn(username, password) {
      // Mock login - always succeeds for demo
      const user = new MockUser();
      user.set('username', username);
      user.set('password', password);
      return user;
    }
    async signUp() {
      // Mock signup - always succeeds
      return this;
    }
  },
  Query: class MockQuery {
    constructor(model) {
      this.model = model;
      this.filters = {};
    }
    equalTo(key, value) {
      this.filters[key] = value;
      return this;
    }
    async first() {
      // Mock query - return null (user not found) for registration
      return null;
    }
  }
};

module.exports = Parse;