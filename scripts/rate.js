const homepage = function () {return chrome.runtime.getManifest().homepage_url};
const updateUrl = chrome.runtime.getManifest().update_url?.toLowerCase();
const id = chrome.runtime.id;

const storeUrl = (updateUrl && updateUrl.includes("microsoft")) ?
    `https://microsoftedge.microsoft.com/addons/detail/` + id :
    `https://chrome.google.com/webstore/detail/${id}/reviews`;

document.querySelectorAll(".teaser").forEach(el =>
    el.setAttribute("href", storeUrl));

let homeLink = document.getElementById("homeLink");
if(homeLink) homeLink.href=homepage();
    