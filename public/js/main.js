document.querySelectorAll('form:not(#ai-form)').forEach(form=>{form.addEventListener('submit',()=>{const b=form.querySelector('button[type="submit"],button:not([type])');if(b&& !form.hasAttribute('onsubmit')){b.dataset.old=b.textContent;b.textContent='Đang xử lý...';}})});

const catalogSearchInput = document.querySelector("#catalog-search-input");
const searchSuggestions = document.querySelector("#product-search-results");
const catalogSearchWrap = document.querySelector(".catalog-search-wrap");
if (catalogSearchInput && searchSuggestions && catalogSearchWrap) {
  const productCards = Array.from(document.querySelectorAll(".product-card"));
  const normalizeSearchText = value => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  const closeSuggestions = () => {
    searchSuggestions.hidden = true;
    catalogSearchInput.setAttribute("aria-expanded", "false");
  };

  const updateSuggestions = () => {
    const query = normalizeSearchText(catalogSearchInput.value);
    searchSuggestions.replaceChildren();
    if (!query) {
      closeSuggestions();
      return;
    }

    const matches = productCards.filter(card =>
      normalizeSearchText(card.dataset.productSearch).includes(query)
    ).slice(0, 6);

    if (!matches.length) {
      const empty = document.createElement("p");
      empty.className = "search-suggestions-empty";
      empty.textContent = "Không tìm thấy sản phẩm phù hợp.";
      searchSuggestions.append(empty);
    } else {
      matches.forEach(card => {
        const result = document.createElement("a");
        const name = card.querySelector("h3")?.textContent.trim() || "Sản phẩm";
        const game = card.querySelector(".product-img span")?.textContent.trim() || "";
        const price = card.querySelector(".product-price strong")?.textContent.trim() || "";
        result.className = "search-suggestion";
        result.href = `#${card.id}`;
        result.setAttribute("role", "option");
        result.dataset.productId = card.id;

        const title = document.createElement("strong");
        title.textContent = name;
        const details = document.createElement("small");
        details.textContent = [game, price].filter(Boolean).join(" · ");
        result.append(title, details);
        searchSuggestions.append(result);
      });
    }

    searchSuggestions.hidden = false;
    catalogSearchInput.setAttribute("aria-expanded", "true");
  };

  catalogSearchInput.addEventListener("input", updateSuggestions);
  catalogSearchInput.addEventListener("focus", updateSuggestions);
  catalogSearchInput.addEventListener("keydown", event => {
    if (event.key === "Escape") closeSuggestions();
  });
  searchSuggestions.addEventListener("click", event => {
    const result = event.target.closest("a[data-product-id]");
    if (!result) return;
    const card = document.getElementById(result.dataset.productId);
    if (!card) return;

    event.preventDefault();
    history.pushState(null, "", result.hash);
    card.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start"
    });
    card.classList.add("product-card-highlight");
    setTimeout(() => card.classList.remove("product-card-highlight"), 1800);
    closeSuggestions();
  });
  document.addEventListener("click", event => {
    if (!catalogSearchWrap.contains(event.target)) closeSuggestions();
  });
}

const themeToggle = document.querySelector("#theme-toggle");
if (themeToggle) {
  const themeKey = "gamehub-theme";
  const updateThemeButton = () => {
    const isDark = document.documentElement.dataset.theme === "dark";
    themeToggle.setAttribute("aria-pressed", String(isDark));
    themeToggle.setAttribute("aria-label", isDark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối");
    themeToggle.title = isDark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối";
    themeToggle.querySelector(".theme-icon").textContent = isDark ? "☀️" : "🌙";
    themeToggle.querySelector(".theme-label").textContent = isDark ? "Sáng" : "Tối";
  };

  updateThemeButton();
  themeToggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nextTheme;
    updateThemeButton();
    try {
      localStorage.setItem(themeKey, nextTheme);
    } catch (error) {
      console.warn("Không thể lưu tùy chọn giao diện.", error);
    }
  });
}

const topupAmount = document.querySelector("#topup-amount");
if (topupAmount) {
  document.querySelectorAll("[data-amount]").forEach(button => {
    button.addEventListener("click", () => {
      topupAmount.value = button.dataset.amount;
      topupAmount.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
}

const aiWidget = document.querySelector(".ai-chat-widget");
if (aiWidget) {
  const launcher = aiWidget.querySelector("#ai-launcher");
  const panel = aiWidget.querySelector("#ai-panel");
  const closeButton = aiWidget.querySelector("#ai-close");
  const form = aiWidget.querySelector("#ai-form");
  const input = aiWidget.querySelector("#ai-input");
  const sendButton = aiWidget.querySelector("#ai-send");
  const messageList = aiWidget.querySelector("#ai-messages");
  const conversation = [];
  const sendLabel = sendButton.textContent;
  panel.hidden = true;
  launcher.setAttribute("aria-expanded", "false");

  const addMessage = (role, text, state = "") => {
    const message = document.createElement("div");
    message.className = `ai-message ai-message-${role}${state ? ` ai-message-${state}` : ""}`;
    message.textContent = text;
    messageList.append(message);
    messageList.scrollTop = messageList.scrollHeight;
    return message;
  };

  const setOpen = isOpen => {
    panel.hidden = !isOpen;
    launcher.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) input.focus();
  };

  launcher.addEventListener("click", () => setOpen(panel.hidden));
  closeButton.addEventListener("click", () => {
    setOpen(false);
    launcher.focus();
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
    if (event.key === "Escape") setOpen(false);
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content || sendButton.disabled) return;

    conversation.push({ role: "user", content });
    if (conversation.length > 8) conversation.shift();
    addMessage("user", content);
    input.value = "";
    sendButton.disabled = true;
    sendButton.textContent = "Đang gửi...";
    form.setAttribute("aria-busy", "true");
    const typingMessage = addMessage("assistant", "Đang suy nghĩ...", "typing");

    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: conversation })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Không thể nhận phản hồi từ AI.");
      if (typeof result.reply !== "string" || !result.reply.trim()) {
        throw new Error("AI trả về nội dung không hợp lệ.");
      }

      typingMessage.remove();
      addMessage("assistant", result.reply);
      conversation.push({ role: "assistant", content: result.reply });
      if (conversation.length > 8) conversation.shift();
    } catch (error) {
      typingMessage.remove();
      console.error("AI chat request failed.", error);
      addMessage("error", error.message || "Không thể kết nối với AI. Vui lòng thử lại.");
    } finally {
      sendButton.disabled = false;
      sendButton.textContent = sendLabel;
      form.removeAttribute("aria-busy");
      input.focus();
    }
  });
}