const checkoutStatus = document.getElementById("checkoutStatus");
const checkoutLinks = document.getElementById("checkoutLinks");
const loadingSpinner = document.getElementById("loadingSpinner");
const params = new URLSearchParams(window.location.search);
const transactionId = params.get("transaction_id");
const paymentStatus = params.get("status");

function addCheckoutLink(text, href) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = text;
    checkoutLinks.appendChild(link);
}

async function verifyPayment() {
    if (paymentStatus === "cancelled") {
        loadingSpinner.hidden = true;
        checkoutStatus.textContent = "Payment was cancelled. No unlimited access was added.";
        addCheckoutLink("Return to chat", "/chat.html");
        addCheckoutLink("Try again", "/plans.html");
        return;
    }
    if (!transactionId || (paymentStatus !== "successful" && paymentStatus !== "completed")) {
        loadingSpinner.hidden = true;
        checkoutStatus.textContent = "We could not confirm a completed payment.";
        addCheckoutLink("Return to chat", "/chat.html");
        addCheckoutLink("View plans", "/plans.html");
        return;
    }

    try {
        const response = await fetch("/api/billing/verify-flw", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transaction_id: transactionId })
        });
        const data = await response.json();
        loadingSpinner.hidden = true;
        if (response.status === 401) {
            checkoutStatus.textContent = "Sign in to the account that made this purchase to finish activating access.";
            const next = window.location.pathname + window.location.search;
            addCheckoutLink("Sign in", "/login.html?next=" + encodeURIComponent(next));
            return;
        }
        if (!response.ok || !data.unlimited) {
            throw new Error(data.error || "Payment could not be verified.");
        }
        checkoutStatus.textContent = "Payment confirmed. Lifetime unlimited chat is now active.";
        addCheckoutLink("Start chatting", "/chat.html");
    } catch (error) {
        loadingSpinner.hidden = true;
        checkoutStatus.textContent = error.message;
        addCheckoutLink("Return to chat", "/chat.html");
        addCheckoutLink("Try again", "/plans.html");
    }
}

verifyPayment();
