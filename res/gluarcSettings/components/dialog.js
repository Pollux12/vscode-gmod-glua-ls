export function showConfirmDialog({ title, message, confirmLabel = "Confirm", onConfirm }) {
    // Prevent multiple modals
    if (document.querySelector(".modal-overlay")) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";

    const header = document.createElement("div");
    header.className = "modal-header";
    header.textContent = title;

    const body = document.createElement("div");
    body.className = "modal-body";
    // Allow multi-line messages by splitting on newline and creating paragraphs
    message.split('\n').forEach(line => {
        const p = document.createElement("p");
        p.textContent = line;
        p.style.margin = "0 0 8px 0";
        body.appendChild(p);
    });

    const footer = document.createElement("div");
    footer.className = "modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn modal-btn-cancel";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "modal-btn modal-btn-confirm";
    confirmBtn.textContent = confirmLabel;

    const close = () => {
        overlay.classList.remove("is-visible");
        setTimeout(() => overlay.remove(), 150);
    };

    // Close on background click
    overlay.onclick = (e) => {
        if (e.target === overlay) close();
    };

    cancelBtn.onclick = close;

    confirmBtn.onclick = () => {
        onConfirm();
        close();
    };

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    document.body.appendChild(overlay);

    // Focus the cancel button to prevent accidental enter presses wiping data
    cancelBtn.focus();

    // Trigger reflow for animation
    requestAnimationFrame(() => {
        overlay.classList.add("is-visible");
    });
}
