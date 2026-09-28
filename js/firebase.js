// ======================================================
// Escala São Miguel
// Firebase
// ======================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
    getAuth,
    browserLocalPersistence,
    browserSessionPersistence,
    setPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

import {
    getFirestore
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

import {
    getStorage
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";


// ======================================================
// CONFIG FIREBASE
// ======================================================

const firebaseConfig = {

    apiKey: "AIzaSyADTCIaxy26enx0W8s7Lnbm5alEGcBN2yo",
    authDomain: "escala-sao-miguel.firebaseapp.com",
    projectId: "escala-sao-miguel",
    storageBucket: "escala-sao-miguel.firebasestorage.app",
    messagingSenderId: "882984117282",
    appId: "1:882984117282:web:c026b7b244370f6174167b"

};


// ======================================================
// INIT
// ======================================================

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);


// ======================================================
// PERSISTÊNCIA SEGURA
// ======================================================

// padrão: sessão (evita login eterno inesperado)
setPersistence(auth, browserLocalPersistence)
    .catch(console.error);

async function lembrarLogin() {
    return setPersistence(auth, browserLocalPersistence);
}

async function sessaoTemporaria() {
    return setPersistence(auth, browserSessionPersistence);
}


// ======================================================
// EXPORTS
// ======================================================

export {
    app,
    auth,
    db,
    storage,
    lembrarLogin,
    sessaoTemporaria
};
