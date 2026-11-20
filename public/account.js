const accountForm = document.getElementById("accountForm");
const accountMessage = document.getElementById("accountMessage");
const switchAccountLink = document.getElementById("switchAccountLink");
const authAction = accountForm.dataset.action;
const searchParams = new URLSearchParams(window.location.search);
const requestedNext = searchParams.get("next");
const nextPage = requestedNext
    && requestedNext.startsWith("/")
    && !requestedNext.startsWith("//")
    && !requestedNext.includes("\\")
    ? requestedNext
    : "/chat.html";

const switchPath = authAction === "register" ? "/login.html" : "/signup.html";
switchAccountLink.href = switchPath + "?next=" + encodeURIComponent(nextPage);

accountForm.addEventListener("submit", async event => {
    event.preventDefault();
    const button = accountForm.querySelector("button[type=submit]");
    button.disabled = true;
    accountMessage.textContent = "";

    try {
        const formData = new FormData(accountForm);
        const response = await fetch("/api/auth/" + authAction, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: formData.get("email"),
                password: formData.get("password")
            })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || "Could not authenticate your account.");
        }
        window.location.assign(nextPage);
    } catch (error) {
        accountMessage.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});
