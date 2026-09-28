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
import { CONFIG_PADRAO, sabadoDoFimDeSemana, hojeISO } from "./escala-engine.js";

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

// Diurna: fim de semana A e B, alternando.
// Noturna: noite de sábado e noite de domingo, todo fim de semana.
export const TURMAS_POR_TIPO = {
    diurna: [
        { id: "A", nome: "Fim de semana A", curto: "Turma A", letra: "A", cor: "#0A9447" },
        { id: "B", nome: "Fim de semana B", curto: "Turma B", letra: "B", cor: "#3B3F96" }
    ],
    noturna: [
        { id: "S", nome: "Noite de sábado", curto: "Sábado", letra: "S", cor: "#3B3F96" },
        { id: "D", nome: "Noite de domingo", curto: "Domingo", letra: "D", cor: "#8A4FBF" }
    ]
};

export const TURMAS = TURMAS_POR_TIPO.diurna;
export const turmasDe = (tipo) => TURMAS_POR_TIPO[tipo] || TURMAS;
const TODAS_TURMAS = [...TURMAS_POR_TIPO.diurna, ...TURMAS_POR_TIPO.noturna];
export const turmaPorId = (id) => TODAS_TURMAS.find((t) => t.id === id) || null;

// Turma do funcionário, só se for válida para a escala dele
export function turmaDe(f) {
    const tipo = tipoDoFuncionario(f);
    return turmasDe(tipo).some((t) => t.id === f?.turma) ? f.turma : null;
}

export function turmaDoTexto(texto, tipo = "diurna") {
    const t = normalizar(texto).replace(/^(fim de semana|fds|turma|grupo|noite de|noite)\s*/, "");
    if (tipo === "noturna") {
        if (["s", "sab", "sabado"].includes(t)) return "S";
        if (["d", "dom", "domingo"].includes(t)) return "D";
        return null;
    }
    if (["a", "1"].includes(t)) return "A";
    if (["b", "2"].includes(t)) return "B";
    return null;
}

// Turma fixa de um feriado na escala (valores que não valem para a escala são ignorados)
export function turmaFixaDoFeriado(feriado, tipo) {
    const v = feriado.equipeFixa?.[tipo];
    return turmasDe(tipo).some((t) => t.id === v) ? v : null;
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

// "ciclo": um encarregado a cada 2 fins de semana (A e B), padrão da diurna
// "turma": cada encarregado tem a sua noite (sábado ou domingo), padrão da noturna
// "dia":   um encarregado por dia, revezando em sequência
export const MODO_ENCARREGADO_PADRAO = { diurna: "ciclo", noturna: "turma" };

export function modoEncarregado(config, tipo) {
    const m = config?.encarregadoModo;
    if (m === "ciclo" || m === "dia" || m === "turma") return m;
    return MODO_ENCARREGADO_PADRAO[tipo];
}

export const TEXTO_MODO_ENCARREGADO = {
    ciclo: "Um encarregado a cada 2 fins de semana (cobre A e B, sábado e domingo)",
    turma: "Cada encarregado tem a sua noite: arraste para Sábado ou Domingo",
    dia: "Um encarregado por dia, revezando em sequência"
};

// encarregado "solto" = fica fora das turmas (revezamento próprio)
export const encarregadoForaDasTurmas = (config, tipo) => modoEncarregado(config, tipo) !== "turma";

// Funcionários ativos de uma escala
export const ativosDaEscala = (funcionarios, tipo) =>
    funcionarios.filter((f) => f.status !== "Inativo" && tipoDoFuncionario(f) === tipo);

// Encarregados ativos da escala, em ordem alfabética (é a ordem do revezamento)
export function encarregadosDaEscala(funcionarios, tipo, equipes) {
    return ativosDaEscala(funcionarios, tipo)
        .filter((f) => ehEncarregado(f, equipes))
        .sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
}

// Ordena por equipe (na ordem das equipes) e nome
export function ordenarPorEquipe(lista, equipes) {
    const pos = new Map(equipes.map((e, i) => [e.id, i]));
    return [...lista].sort((a, b) =>
        (pos.get(a.equipeId) ?? 999) - (pos.get(b.equipeId) ?? 999) ||
        (a.nome || "").localeCompare(b.nome || "")
    );
}

// Agrupa pessoas por equipe (função/setor) ou por cargo
export function agruparPessoas(pessoas, equipes, por = "equipe") {
    const grupos = [];
    const ordenadas = por === "cargo"
        ? [...pessoas].sort((a, b) => (a.funcao || "~").localeCompare(b.funcao || "~") || (a.nome || "").localeCompare(b.nome || ""))
        : ordenarPorEquipe(pessoas, equipes);

    ordenadas.forEach((f) => {
        let chave, nome, cor;
        if (por === "cargo") {
            chave = normalizar(f.funcao) || "";
            nome = f.funcao || "Sem cargo";
            cor = "#8b93a1";
        } else {
            const e = equipes.find((x) => x.id === f.equipeId);
            chave = e?.id || "";
            nome = e?.nome || "Sem equipe";
            cor = e?.cor || "#8b93a1";
        }
        let g = grupos.find((x) => x.chave === chave);
        if (!g) grupos.push((g = { chave, nome, cor, pessoas: [] }));
        g.pessoas.push(f);
    });
    return grupos;
}

// Quem trabalha no dia (dia.equipeId é a turma: "A" ou "B"; dia.encarregadoId vem
// de atribuirEncarregados). Encarregados nunca entram na lista de integrantes.
export function pessoasDoDia(dia, funcionarios, ajustes, tipo, equipes, agruparPor = "equipe") {
    const ausencias = ajustes?.ausencias?.[dia.data] || {};
    const comAusencia = (f) => ({ ...f, ausencia: ausencias[f.id] || null });
    const ativos = ativosDaEscala(funcionarios, tipo);

    const lider = dia.encarregadoId ? ativos.find((f) => f.id === dia.encarregadoId) : null;
    const integrantes = ativos
        .filter((f) => !ehEncarregado(f, equipes) && turmaDe(f) === dia.equipeId)
        .map(comAusencia);

    return {
        encarregado: lider ? comAusencia(lider) : null,
        integrantes,
        grupos: agruparPessoas(integrantes, equipes, agruparPor)
    };
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

// Escala ainda sem rodízio salvo: parte deste fim de semana com a turma A.
// Todas as telas usam esta mesma regra, para mostrarem sempre a mesma turma.
export function completarConfig(config, tipo = "diurna") {
    const primeira = turmasDe(tipo)[0].id;
    const valida = (v) => (turmasDe(tipo).some((t) => t.id === v) ? v : primeira);
    const base = config?.existe
        ? { ...config }
        : {
            ...CONFIG_PADRAO,
            ...config,
            dataReferencia: sabadoDoFimDeSemana(hojeISO()),
            existe: false,
            novo: true
        };

    // noturna gravada antes desta versão ("um por dia, revezando"): passa a
    // "cada encarregado com a sua noite", que é o jeito da noite trabalhar
    if (tipo === "noturna" && base.encarregadoModo === "dia" && !base.versao) base.encarregadoModo = "turma";

    base.equipeInicialId = valida(base.equipeInicialId);
    base.feriadoEquipeInicialId = valida(base.feriadoEquipeInicialId);
    if (tipo === "noturna") base.modo = "pordia";        // noite: sábado e domingo fixos
    else if (base.modo === "pordia") base.modo = "fimdesemana";
    return base;
}

export async function salvarConfig(tipo, config) {
    const { existe, novo, atualizadoEm, ...dados } = config;
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
