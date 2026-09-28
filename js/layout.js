// ======================================================
// Escala São Miguel
// layout.js — menu lateral, proteção de login e avisos (toast)
// ======================================================

// Importar auth.js já ativa o redirecionamento para o login
// quando não houver usuário conectado.
import { logout } from "./auth.js";

const LINKS = [
    { id: "dashboard", href: "/dashboard.html", icone: "fa-house", texto: "Início" },
    { id: "funcionarios", href: "/pages/funcionarios.html", icone: "fa-people-group", texto: "Equipes" },
    { id: "escalas", href: "/pages/escalas.html", icone: "fa-calendar-week", texto: "Escala" }
];

export function montarLayout(paginaAtiva) {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;

    sidebar.innerHTML = `
        <a class="sidebar-marca" href="/dashboard.html" aria-label="Início">
            <img src="/img/logo-sao-miguel.png" alt="São Miguel">
        </a>
        <p class="sidebar-produto">Escala de manutenção</p>
        <nav class="sidebar-nav">
            ${LINKS.map((l) => `
                <a href="${l.href}" class="${l.id === paginaAtiva ? "ativo" : ""}"
                   ${l.id === paginaAtiva ? 'aria-current="page"' : ""}>
                    <i class="fa-solid ${l.icone}" aria-hidden="true"></i>
                    <span>${l.texto}</span>
                </a>`).join("")}
        </nav>
        <button type="button" class="sidebar-sair" id="btnLogout">
            <i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i>
            <span>Sair</span>
        </button>
    `;

    document.getElementById("btnLogout").addEventListener("click", async () => {
        if (!confirm("Deseja sair do sistema?")) return;
        try {
            await logout();
        } catch (erro) {
            console.error(erro);
            aviso("Não foi possível sair. Tente novamente.", "erro");
        }
    });
}

// ------------------------------------------------------
// Aviso rápido no canto da tela
// ------------------------------------------------------

export function aviso(texto, tipo = "ok") {
    let area = document.getElementById("areaAvisos");
    if (!area) {
        area = document.createElement("div");
        area.id = "areaAvisos";
        area.className = "avisos";
        area.setAttribute("role", "status");
        area.setAttribute("aria-live", "polite");
        document.body.appendChild(area);
    }

    const el = document.createElement("div");
    el.className = `toast toast--${tipo}`;
    el.textContent = texto;
    area.appendChild(el);

    setTimeout(() => {
        el.classList.add("saindo");
        setTimeout(() => el.remove(), 300);
    }, 3200);
}
