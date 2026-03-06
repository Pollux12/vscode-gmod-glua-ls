function showToast() {
    const toast = document.getElementById("toast");
    if (!toast) {
        return;
    }

    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

function setupSearch() {
    const input = document.getElementById("searchInput");
    const clearBtn = document.getElementById("searchClear");
    if (!input || !clearBtn || input.dataset.searchBound === "true") {
        return;
    }

    input.dataset.searchBound = "true";

    input.addEventListener("input", () => {
        const query = input.value;
        updateFilter(query);
        clearBtn.style.display = query ? "block" : "none";
    });

    clearBtn.addEventListener("click", () => {
        input.value = "";
        updateFilter("");
        clearBtn.style.display = "none";
        input.focus();
    });
}

function updateFilter(query) {
    const cleanQuery = query.trim().toLowerCase();
    const sections = document.querySelectorAll("section");
    const items = document.querySelectorAll(".category-item");
    const info = document.getElementById("searchResultsInfo");
    const noResultsState = document.getElementById("noResultsState");

    let totalMatches = 0;

    sections.forEach((section, index) => {
        let sectionVisibleCount = 0;
        const rows = section.querySelectorAll(".setting-row, .object-list-field");
        const matchingContainers = new Set();
        const sectionMatches =
            matchesText(
                section.querySelector(".section-heading h2")?.textContent,
                cleanQuery,
            ) ||
            matchesText(
                section.querySelector(".section-heading .section-description")
                    ?.textContent,
                cleanQuery,
            );

        section.querySelectorAll(".collapsible-group").forEach((container) => {
            if (
                matchesText(
                    container.querySelector("summary")?.textContent,
                    cleanQuery,
                ) ||
                matchesText(
                    container.querySelector(".collapsible-group-info .setting-description")
                        ?.textContent,
                    cleanQuery,
                ) ||
                matchesText(container.dataset.path, cleanQuery)
            ) {
                matchingContainers.add(container);
            }
        });

        rows.forEach((row) => {
            const labelEl = row.querySelector(".setting-label");
            const descEl = row.querySelector(".setting-description");
            const pathText = row.dataset.path || "";
            const parentContainer = row.closest(".collapsible-group");

            if (labelEl) {
                const raw = labelEl.textContent ?? "";
                labelEl.textContent = raw;
            }
            if (descEl) {
                const raw = descEl.textContent ?? "";
                descEl.textContent = raw;
            }

            const labelText = labelEl ? labelEl.textContent ?? "" : "";
            const descText = descEl ? descEl.textContent ?? "" : "";
            const match =
                !cleanQuery ||
                sectionMatches ||
                (parentContainer && matchingContainers.has(parentContainer)) ||
                labelText.toLowerCase().includes(cleanQuery) ||
                descText.toLowerCase().includes(cleanQuery) ||
                pathText.toLowerCase().includes(cleanQuery);

            if (match) {
                setRowVisibility(row, true);
                sectionVisibleCount++;
                if (cleanQuery) {
                    if (labelEl) {
                        highlightElement(labelEl, cleanQuery);
                    }
                    if (descEl) {
                        highlightElement(descEl, cleanQuery);
                    }
                }
            } else {
                setRowVisibility(row, false);
            }
        });

        updateCompositeVisibility(section, ".collapsible-group");
        updateCompositeVisibility(section, ".object-list-item");

        if (sectionVisibleCount > 0) {
            section.style.display = "block";
            if (items[index]) {
                items[index].style.display = "block";
            }
            totalMatches += sectionVisibleCount;
        } else {
            section.style.display = "none";
            if (items[index]) {
                items[index].style.display = "none";
            }
        }
    });

    if (cleanQuery) {
        info.textContent =
            totalMatches === 0
                ? "No settings match your search"
                : `Found ${totalMatches} matching setting${totalMatches === 1 ? "" : "s"}`;
    } else {
        info.textContent = "";
    }

    if (noResultsState) {
        noResultsState.style.display =
            cleanQuery && totalMatches === 0 ? "flex" : "none";
    }
}

function updateCompositeVisibility(section, selector) {
    section.querySelectorAll(selector).forEach((container) => {
        const nestedRows = Array.from(
            container.querySelectorAll(".setting-row, .object-list-field"),
        );
        if (nestedRows.length === 0) {
            return;
        }

        const hasVisibleRows = nestedRows.some(
            (row) => !row.classList.contains("is-filtered-out"),
        );
        container.style.display = hasVisibleRows ? "" : "none";
    });
}

function setRowVisibility(row, visible) {
    if (row.__filterHideTimer) {
        clearTimeout(row.__filterHideTimer);
        row.__filterHideTimer = undefined;
    }

    if (visible) {
        row.style.display = "";
        row.classList.remove("is-filtered-out");
        return;
    }

    row.classList.add("is-filtered-out");
    row.__filterHideTimer = setTimeout(() => {
        if (row.classList.contains("is-filtered-out")) {
            row.style.display = "none";
        }
        row.__filterHideTimer = undefined;
    }, 55);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function highlightElement(element, query) {
    const text = element.textContent ?? "";
    const escapedText = escapeHtml(text);
    const escapedQuery = escapeHtml(query);
    const regex = new RegExp(`(${escapeRegExp(escapedQuery)})`, "gi");
    element.innerHTML = escapedText.replace(regex, "<mark>$1</mark>");
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesText(value, query) {
    return Boolean(query) && typeof value === "string" && value.toLowerCase().includes(query);
}

export { showToast, setupSearch, updateFilter, escapeHtml };
