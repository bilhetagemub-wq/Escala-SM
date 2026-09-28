// ======================================================
// Escala São Miguel
// dados.js — acesso ao Firestore compartilhado entre as telas
// ======================================================
//
// Coleções usadas:
//   equipes       { nome, cor, ordem }
//   funcionarios  { nome, matricula, funcao, turno, status, equipeId, ordem }
//   feriados      { data: "AAAA-MM-DD", descricao, equipeFixaId }
//   config/escala { modo, dataReferencia, equipeInicialId, feriadoEquipeInicialId, feriadoNoFimDeSemana }
//   escalas/{AAAA-MM} { trocas, ausencias, dias (retrato salvo), atualizadoEm }

import { db } from "./firebase.js";
import { CONFIG_PADRAO } from "./escala-engine.js";

import {
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    onSnapshot,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

export const CORES_EQUIPE = [
    "#EF3A42", // vermelho São Miguel
    "#0A9447", // verde São Miguel
    "#3B3F96", // azul São Miguel
    "#E39A12",
    "#0E8A8A",
    "#8A4FBF",
    "#D9611C",
    "#55657A"
];

export const ROTULO_AUSENCIA = { FE: "Férias", A: "Afastamento" };

// ------------------------------------------------------
// Ordenação
// ------------------------------------------------------

export function ordenarEquipes(lista) {
    return [...lista].sort((a, b) =>
        (a.ordem ?? 9999) - (b.ordem ?? 9999) || (a.nome || "").localeCompare(b.nome || "")
    );
}

export function ordenarFuncionarios(lista) {
    return [...lista].sort((a, b) =>
        (a.ordem ?? 9999) - (b.ordem ?? 9999) || (a.nome || "").localeCompare(b.nome || "")
    );
}

// ------------------------------------------------------
// Leitura em tempo real
// ------------------------------------------------------

function ouvir(nome, ordenar, callback) {
    return onSnapshot(
        collection(db, nome),
        (snap) => {
            const lista = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            callback(ordenar ? ordenar(lista) : lista);
        },
        (erro) => console.error(`Erro ao ler ${nome}:`, erro)
    );
}

export const ouvirEquipes = (cb) => ouvir("equipes", ordenarEquipes, cb);
export const ouvirFuncionarios = (cb) => ouvir("funcionarios", ordenarFuncionarios, cb);
export const ouvirFeriados = (cb) =>
    ouvir("feriados", (l) => l.sort((a, b) => a.data.localeCompare(b.data)), cb);

// ------------------------------------------------------
// Leitura única (dashboard)
// ------------------------------------------------------

export async function lerColecao(nome) {
    const snap = await getDocs(collection(db, nome));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ------------------------------------------------------
// Configuração do rodízio
// ------------------------------------------------------

export async function lerConfig() {
    const snap = await getDoc(doc(db, "config", "escala"));
    return snap.exists() ? { ...CONFIG_PADRAO, ...snap.data(), existe: true } : { ...CONFIG_PADRAO, existe: false };
}

export async function salvarConfig(config) {
    const { existe, ...dados } = config;
    await setDoc(doc(db, "config", "escala"), { ...dados, atualizadoEm: serverTimestamp() }, { merge: true });
}

// ------------------------------------------------------
// Ajustes do mês (trocas de equipe e ausências)
// ------------------------------------------------------

export async function lerAjustesDoMes(mesISO) {
    const snap = await getDoc(doc(db, "escalas", mesISO));
    if (!snap.exists()) return { trocas: {}, ausencias: {}, salvo: false };
    const d = snap.data();
    return {
        trocas: d.trocas || {},
        ausencias: d.ausencias || {},
        salvo: true,
        atualizadoEm: d.atualizadoEm?.toDate?.() || null
    };
}

export async function salvarEscalaDoMes(mesISO, ajustes, retrato) {
    await setDoc(doc(db, "escalas", mesISO), {
        mes: mesISO,
        trocas: ajustes.trocas || {},
        ausencias: ajustes.ausencias || {},
        dias: retrato,
        atualizadoEm: serverTimestamp()
    });
}

// ------------------------------------------------------
// Utilidades de interface
// ------------------------------------------------------

export function esc(texto) {
    return String(texto ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

export function iniciais(nome) {
    const partes = String(nome || "?").trim().split(/\s+/);
    const a = partes[0]?.[0] || "?";
    const b = partes.length > 1 ? partes[partes.length - 1][0] : "";
    return (a + b).toUpperCase();
}
