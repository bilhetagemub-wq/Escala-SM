// ======================================================
// Escala São Miguel
// dados.js — acesso ao Firestore compartilhado entre as telas
// ======================================================
//
// Coleções usadas:
//   equipes       { nome, cor, ordem }   (a função: Elétrica, Mecânica...)
//   funcionarios  { nome, matricula, equipeId, funcao (cargo), turno: "Diurno" | "Noturno",
//                   turma: "A" | "B" | null, lider, status }
//   feriados      { data: "AAAA-MM-DD", descricao, equipeFixa: { diurna: "A"|"B"|null, noturna } }
//   config/escala-{tipo}      { modo, dataReferencia, equipeInicialId, feriadoEquipeInicialId, feriadoNoFimDeSemana }
//   escalas/{AAAA-MM}-{tipo}  { trocas, ausencias, encarregados, dias (retrato salvo), atualizadoEm }

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
// Cada tipo tem seu próprio rodízio de turmas, fila de feriados e escala
// salva. O funcionário pertence ao tipo pelo campo "turno".

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

// ------------------------------------------------------
// Turmas de fim de semana
// ------------------------------------------------------
// O rodízio é por turma: no fim de semana A trabalham todos da turma A,
// no fim de semana B, todos da turma B. As equipes são só a função
// (Elétrica, Mecânica...) e servem para organizar a lista.

export const TURMAS = [
    { id: "A", nome: "Fim de semana A", curto: "Turma A", cor: "#0A9447" },
    { id: "B", nome: "Fim de semana B", curto: "Turma B", cor: "#3B3F96" }
];

export const turmaPorId = (id) => TURMAS.find((t) => t.id === id) || null;
export const turmaDe = (f) => (f?.turma === "A" || f?.turma === "B" ? f.turma : null);

export function turmaDoTexto(texto) {
    const t = normalizar(texto).replace(/^(fim de semana|fds|turma|grupo)\s*/, "");
    if (["a", "1"].includes(t)) return "A";
    if (["b", "2"].includes(t)) return "B";
    return null;
}

// Turma fixa de um feriado na escala (valores antigos que não sejam A/B são ignorados)
export function turmaFixaDoFeriado(feriado, tipo) {
    const v = feriado.equipeFixa?.[tipo];
    return v === "A" || v === "B" ? v : null;
}

// ------------------------------------------------------
// Encarregados
// ------------------------------------------------------
// Marcado no cadastro. Sem marcação, vale o cargo ou a equipe
// com "encarregado" no nome.

export function ehEncarregado(f, equipes = []) {
    if (typeof f?.lider === "boolean") return f.lider;
    if (normalizar(f?.funcao).includes("encarregad")) return true;
    const equipe = equipes.find((e) => e.id === f?.equipeId);
    return normalizar(equipe?.nome).includes("encarregad");
}

// "todos": trabalha nos dois fins de semana (padrão da diurna)
// "turma": trabalha só no fim de semana da turma dele (padrão da noturna)
export const MODO_ENCARREGADO_PADRAO = { diurna: "todos", noturna: "turma" };

export function modoEncarregado(config, tipo) {
    const m = config?.encarregadoModo;
    if (m === "todos" || m === "proprio") return "todos";
    if (m === "turma" || m === "equipe") return "turma";
    return MODO_ENCARREGADO_PADRAO[tipo];
}

// Funcionários ativos de uma escala
export const ativosDaEscala = (funcionarios, tipo) =>
    funcionarios.filter((f) => f.status !== "Inativo" && tipoDoFuncionario(f) === tipo);

// Ordena por equipe (na ordem das equipes) e nome
export function ordenarPorEquipe(lista, equipes) {
    const pos = new Map(equipes.map((e, i) => [e.id, i]));
    return [...lista].sort((a, b) =>
        (pos.get(a.equipeId) ?? 999) - (pos.get(b.equipeId) ?? 999) ||
        (a.nome || "").localeCompare(b.nome || "")
    );
}

// Quem trabalha no dia (dia.equipeId é a turma: "A" ou "B")
// Devolve os encarregados em destaque e os demais agrupados por equipe.
export function pessoasDoDia(dia, funcionarios, ajustes, tipo, modo, equipes) {
    const ausencias = ajustes?.ausencias?.[dia.data] || {};
    const comAusencia = (f) => ({ ...f, ausencia: ausencias[f.id] || null });
    const ativos = ativosDaEscala(funcionarios, tipo);

    const encarregados = ordenarPorEquipe(
        ativos.filter((f) => ehEncarregado(f, equipes) && (modo === "todos" || turmaDe(f) === dia.equipeId)),
        equipes
    ).map(comAusencia);

    const integrantes = ordenarPorEquipe(
        ativos.filter((f) => !ehEncarregado(f, equipes) && turmaDe(f) === dia.equipeId),
        equipes
    ).map(comAusencia);

    // agrupa por equipe, na ordem das equipes; sem equipe por último
    const grupos = [];
    integrantes.forEach((f) => {
        const id = equipes.some((e) => e.id === f.equipeId) ? f.equipeId : "";
        let g = grupos.find((x) => x.equipeId === id);
        if (!g) {
            const e = equipes.find((x) => x.id === id);
            g = { equipeId: id, nome: e?.nome || "Sem equipe", cor: e?.cor || "#8b93a1", pessoas: [] };
            grupos.push(g);
        }
        g.pessoas.push(f);
    });

    return { encarregados, integrantes, grupos };
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
    if (!snap.exists()) return { trocas: {}, ausencias: {}, encarregados: {}, salvo: false };
    const d = snap.data();
    return {
        trocas: d.trocas || {},
        ausencias: d.ausencias || {},
        encarregados: d.encarregados || {},
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
        encarregados: ajustes.encarregados || {},
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
