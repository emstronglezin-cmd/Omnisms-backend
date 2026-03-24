// Mock Firebase Admin SDK
const admin = {
  initializeApp: () => {},
  credential: {
    cert: () => ({})
  },
  messaging: () => ({
    send: () => Promise.resolve('mock-message-id')
  }),
  firestore: () => ({
    collection: () => ({
      doc: () => ({
        set: () => Promise.resolve(),
        get: () => Promise.resolve({ exists: false, data: () => ({}) }),
        update: () => Promise.resolve()
      }),
      where: () => ({
        get: () => Promise.resolve({ docs: [] })
      })
    })
  })
};

module.exports = admin;