// Firebase configuration for ballotboxdelivery project
const firebaseConfig = {
  apiKey: "AIzaSyCunvpHKkr0YTkR8hhqzFkUhUYSTI1z6pg",
  authDomain: "ballotboxdelivery.firebaseapp.com",
  projectId: "ballotboxdelivery",
  storageBucket: "ballotboxdelivery.firebasestorage.app",
  messagingSenderId: "538954246860",
  appId: "1:538954246860:web:7f2af9813047ce6ba1f069",
  measurementId: "G-DY737SSX2V"
};

// Initialize Firebase
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
  
  // Enable offline persistence for Firestore
  firebase.firestore().enablePersistence({ synchronizeTabs: true })
    .catch((err) => {
      if (err.code == 'failed-precondition') {
        console.warn('Multiple tabs open, persistence can only be enabled in one tab at a time.');
      } else if (err.code == 'unimplemented') {
        console.warn('The current browser does not support all of the features required to enable persistence');
      }
    });
}
