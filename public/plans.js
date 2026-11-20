const purchaseButton = document.getElementById("purchaseButton");
const planMessage = document.getElementById("planMessage");
let signInRequired = false;

async function loadPurchaseState() {
    try {
        const response = await fetch("/api/auth/me");
        const data = await response.json();
        if (response.status === 401) {
            signInRequired = true;
            purchaseButton.disabled = false;
            purchaseButton.textContent = "Sign in to continue";
            planMessage.append("You need an account to buy lifetime access. ");
            const signupLink = document.createElement("a");
            signupLink.href = "/signup.html?next=%2Fplans.html";
            signupLink.textContent = "Create account";
            const loginLink = document.createElement("a");
            loginLink.href = "/login.html?next=%2Fplans.html";
            loginLink.textContent = "Sign in";
            planMessage.append(signupLink, " or ", loginLink, ".");
            return;
        }
        if (!response.ok) {
            throw new Error(data.error || "Could not check your account.");
        }
        if (data.user.unlimitedChat) {
            purchaseButton.hidden = true;
            planMessage.textContent = "Lifetime unlimited chat is already active on your account.";
            const link = document.createElement("a");
            link.className = "button";
            link.href = "/chat.html";
            link.textContent = "Start chatting";
            purchaseButton.insertAdjacentElement("afterend", link);
            return;
        }
        purchaseButton.disabled = false;
        purchaseButton.textContent = "Pay $10 once";
        planMessage.textContent = "Signed in as " + data.user.email + ".";
    } catch (error) {
        planMessage.textContent = error.message;
    }
}

purchaseButton.addEventListener("click", async () => {
    if (signInRequired) {
        window.location.href = "/login.html?next=%2Fplans.html";
        return;
    }

    purchaseButton.disabled = true;
    purchaseButton.textContent = "Opening secure checkout...";
    planMessage.textContent = "";
    try {
        const response = await fetch("/api/billing/initialize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });
        const data = await response.json();
        if (response.status === 401) {
            window.location.href = "/login.html?next=%2Fplans.html";
            return;
        }
        if (!response.ok || !data.authorizationUrl) {
            throw new Error(data.error || "Could not start checkout.");
        }
        window.location.assign(data.authorizationUrl);
    } catch (error) {
        planMessage.textContent = error.message;
        purchaseButton.disabled = false;
        purchaseButton.textContent = "Pay $10 once";
    }
});

loadPurchaseState();
