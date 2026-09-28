// ======================================================
// Escala São Miguel
// dados.js — acesso ao Firestore compartilhado entre as telas
// ======================================================
//
// Coleções usadas:
//   equipes       { nome, cor, ordem, escala: "diurna" | "noturna" }
//   funcionarios  { nome, matricula, funcao, turno: "Diurno" | "Noturno", status, equipeId, ordem }
//   feriados      { data: "AAAA-MM-DD", descricao, equipeFixa: { diurna, noturna } }
//   config/escala-{tipo}      { modo, dataReferencia, equipeInicialId, feriadoEquipeInicialId, feriadoNoFimDeSemana }
//   escalas/{AAAA-MM}-{tipo}  { trocas, ausencias, dias (retrato salvo), atualizadoEm }

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
// Tipos de escala: diurna e noturna
// ------------------------------------------------------
// Cada tipo tem suas próprias equipes, rodízio, fila de feriados
// e escala salva. O funcionário pertence ao tipo pelo campo "turno".

export const TIPOS = {
    diurna: { id: "diurna", rotulo: "Escala diurna", curto: "Diurna", turno: "Diurno", icone: "fa-sun" },
    noturna: { id: "noturna", rotulo: "Escala noturna", curto: "Noturna", turno: "Noturno", icone: "fa-moon" }
};

// Texto para comparação: sem acento, sem espaços extras, minúsculo
export function normalizar(texto) {
    return String(texto ?? "")
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

// Aceita os valores antigos (Manhã / Noite) e variações digitadas na planilha
export function tipoDoTexto(texto) {
    const t = normalizar(texto);
    if (!t) return null;
    if (["noturna", "noturno", "noite", "n"].includes(t)) return "noturna";
    if (["diurna", "diurno", "dia", "manha", "tarde", "d"].includes(t)) return "diurna";
    return null;
}

export const tipoDoFuncionario = (f) => tipoDoTexto(f?.turno) || "diurna";
export const tipoDaEquipe = (e) => (e?.escala === "noturna" ? "noturna" : "diurna");

// Equipe fixa de um feriado para o tipo (compatível com o campo antigo equipeFixaId)
export function equipeFixaDoTipo(feriado, tipo, equipes) {
    if (feriado.equipeFixa && tipo in feriado.equipeFixa) return feriado.equipeFixa[tipo] || null;
    const antiga = feriado.equipeFixaId;
    if (antiga && equipes.some((e) => e.id === antiga && tipoDaEquipe(e) === tipo)) return antiga;
    return null;
}

export function proximaCor(equipes) {
    const usadas = new Set(equipes.map((e) => e.cor));
    return CORES_EQUIPE.find((c) => !usadas.has(c)) || CORES_EQUIPE[equipes.length % CORES_EQUIPE.length];
}

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

export async function lerConfig(tipo = "diurna") {
    let snap = await getDoc(doc(db, "config", `escala-${tipo}`));

    // A versão anterior tinha uma configuração só: vale para a diurna
    if (!snap.exists() && tipo === "diurna") snap = await getDoc(doc(db, "config", "escala"));

    return snap.exists() ? { ...CONFIG_PADRAO, ...snap.data(), existe: true } : { ...CONFIG_PADRAO, existe: false };
}

export async function salvarConfig(tipo, config) {
    const { existe, atualizadoEm, ...dados } = config;
    await setDoc(doc(db, "config", `escala-${tipo}`), { ...dados, tipo, atualizadoEm: serverTimestamp() }, { merge: true });
}

// ------------------------------------------------------
// Ajustes do mês (trocas de equipe e ausências)
// ------------------------------------------------------

export async function lerAjustesDoMes(mesISO, tipo = "diurna") {
    let snap = await getDoc(doc(db, "escalas", `${mesISO}-${tipo}`));
    if (!snap.exists() && tipo === "diurna") snap = await getDoc(doc(db, "escalas", mesISO));
    if (!snap.exists()) return { trocas: {}, ausencias: {}, salvo: false };
    const d = snap.data();
    return {
        trocas: d.trocas || {},
        ausencias: d.ausencias || {},
        salvo: true,
        atualizadoEm: d.atualizadoEm?.toDate?.() || null
    };
}

export async function salvarEscalaDoMes(mesISO, tipo, ajustes, retrato) {
    await setDoc(doc(db, "escalas", `${mesISO}-${tipo}`), {
        mes: mesISO,
        tipo,
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
